import {Intermediary, ServicesType} from "./Intermediary";
import {SwapType} from "../swaps/SwapType";
import * as BN from "bn.js";
import {SwapContract} from "crosslightning-base/dist";
import {EventEmitter} from "events";
import {Buffer} from "buffer";
import {getLogger, httpGet, tryWithRetries} from "../utils/Utils";
import {IntermediaryAPI} from "./IntermediaryAPI";
import {ChainType} from "crosslightning-base";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    tokens: string[],
    chainTokens?: {[chainId: string]: string[]};
    data?: any,
};

type InfoHandlerResponseEnvelope = {
    nonce: string,
    services: {
        [key in SwapHandlerType]?: SwapHandlerInfoType
    }
};

export type TokenBounds = {
    [token: string]: {
        min: BN,
        max: BN
    }
}

export type MultichainTokenBounds = {
    [chainId: string]: TokenBounds
}

export type SwapBounds = {
    [key in SwapType]?: TokenBounds
}

export type MultichainSwapBounds = {
    [key in SwapType]?: MultichainTokenBounds
}

/**
 * Converts SwapHandlerType (represented as string & used in REST API communication with intermediaries) to regular
 *  SwapType
 *
 * @param swapHandlerType
 */
function swapHandlerTypeToSwapType(swapHandlerType: SwapHandlerType): SwapType {
    switch (swapHandlerType) {
        case SwapHandlerType.FROM_BTC:
            return SwapType.FROM_BTC;
        case SwapHandlerType.TO_BTC:
            return SwapType.TO_BTC;
        case SwapHandlerType.FROM_BTCLN:
            return SwapType.FROM_BTCLN;
        case SwapHandlerType.TO_BTCLN:
            return SwapType.TO_BTCLN;
    }
}

/**
 * A default intermediary comparator, only takes to announced fee into consideration
 *
 * @param swapType
 * @param tokenAddress
 * @param swapAmount
 */
function getIntermediaryComparator(swapType: SwapType, tokenAddress: string, swapAmount?: BN) {

    if(swapType===SwapType.TO_BTC) {
        //TODO: Also take reputation into account
    }

    return (a: Intermediary, b: Intermediary): number => {
        if(swapAmount==null) {
            return new BN(a.services[swapType].swapFeePPM).sub(new BN(b.services[swapType].swapFeePPM)).toNumber();
        } else {
            const feeA = new BN(a.services[swapType].swapBaseFee).add(swapAmount.mul(new BN(a.services[swapType].swapFeePPM)).div(new BN(1000000)));
            const feeB = new BN(b.services[swapType].swapBaseFee).add(swapAmount.mul(new BN(b.services[swapType].swapFeePPM)).div(new BN(1000000)));

            return feeA.sub(feeB).toNumber();
        }
    }

}

const logger = getLogger("IntermediaryDiscovery: ");

const REGISTRY_URL = "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry.json?ref=main";

//To allow for legacy responses from not-yet updated LPs
const DEFAULT_CHAIN = "SOLANA";

export class IntermediaryDiscovery extends EventEmitter {

    intermediaries: Intermediary[];

    swapContracts: {[key: string]: SwapContract};
    registryUrl: string;

    httpRequestTimeout?: number;

    private overrideNodeUrls?: string[];

    constructor(
        swapContracts: {[key: string]: SwapContract},
        registryUrl: string = REGISTRY_URL,
        nodeUrls?: string[],
        httpRequestTimeout?: number
    ) {
        super();
        this.swapContracts = swapContracts;
        this.registryUrl = registryUrl;
        this.overrideNodeUrls = nodeUrls;
        this.httpRequestTimeout = httpRequestTimeout;
    }

    /**
     * Fetches the URLs of swap intermediaries from registry or from a pre-defined array of node urls
     *
     * @param abortSignal
     */
    private async getIntermediaryUrls(abortSignal?: AbortSignal): Promise<string[]> {
        if(this.overrideNodeUrls!=null && this.overrideNodeUrls.length>0) {
            return this.overrideNodeUrls;
        }

        const response = await httpGet<{content: string}>(this.registryUrl, this.httpRequestTimeout, abortSignal);

        const content = response.content.replace(new RegExp("\\n", "g"), "");

        return JSON.parse(Buffer.from(content, "base64").toString()) as string[];
    }

    /**
     * Returns data as reported by a specific node (as identified by its URL)
     *
     * @param url
     * @param abortSignal
     */
    private async getNodeInfo(url: string, abortSignal?: AbortSignal) : Promise<{addresses: {[key: string]: string}, info: InfoHandlerResponseEnvelope}> {
        const response = await IntermediaryAPI.getIntermediaryInfo(url);

        //Handle legacy responses
        if(response.chains==null) response.chains = {
            [DEFAULT_CHAIN]: {address: response.address, signature: response.signature}
        };

        const addresses: {[key: string]: string} = {};
        for(let chain in response.chains) {
            if(this.swapContracts[chain]!=null) {
                const {signature, address} = response.chains[chain];
                await this.swapContracts[chain].isValidDataSignature(Buffer.from(response.envelope), signature, address);
                addresses[chain] = address;
            }
        }
        if(abortSignal!=null) abortSignal.throwIfAborted();

        //Handle legacy responses
        const info: InfoHandlerResponseEnvelope = JSON.parse(response.envelope);
        for(let swapType in info.services) {
            const serviceData: SwapHandlerInfoType = info.services[swapType];
            if(serviceData.chainTokens==null) serviceData.chainTokens = {
                [DEFAULT_CHAIN]: serviceData.tokens
            };
        }

        return {
            addresses,
            info
        };
    }

    /**
     * Fetches data about all intermediaries in the network, pinging every one of them and ensuring they are online
     *
     * @param abortSignal
     * @private
     * @throws {Error} When no online intermediary was found
     */
    private async fetchIntermediaries(abortSignal?: AbortSignal): Promise<Intermediary[]> {
        const urls = await this.getIntermediaryUrls(abortSignal);

        logger.debug("fetchIntermediaries(): Pinging intermediaries: ", urls.join());

        const promises: Promise<Intermediary | null>[] = urls.map(url => this.getNodeInfo(url, abortSignal).then((node) => {
            const services: ServicesType = {};
            for(let key in node.info.services) {
                services[swapHandlerTypeToSwapType(key as SwapHandlerType)] = node.info.services[key];
            }
            return new Intermediary(url, node.addresses, services);
        }).catch(e => {
            logger.error("fetchIntermediaries(): Error contacting intermediary "+url+": ", e);
            return null;
        }));

        const activeNodes: Intermediary[] = (await Promise.all(promises)).filter(intermediary => intermediary!=null);
        if(activeNodes.length===0) throw new Error("No online intermediary found!");

        return activeNodes;
    }

    /**
     * Reloads the saves a list of intermediaries
     * @param abortSignal
     */
    async reloadIntermediaries(abortSignal?: AbortSignal): Promise<void> {
        const fetchedIntermediaries = await tryWithRetries<Intermediary[]>(() => this.fetchIntermediaries(abortSignal), null, null, abortSignal);
        this.intermediaries = fetchedIntermediaries;
        this.emit("added", fetchedIntermediaries);

        logger.info("reloadIntermediaries(): Using active intermediaries: ", fetchedIntermediaries.map(lp => lp.url).join());
    }

    /**
     * Initializes the discovery by fetching/reloading intermediaries
     *
     * @param abortSignal
     */
    init(abortSignal?: AbortSignal): Promise<void> {
        logger.info("init(): Initializing with registryUrl: "+this.registryUrl+" intermediary array: "+(this.overrideNodeUrls || []).join());
        return this.reloadIntermediaries(abortSignal);
    }

    getMultichainSwapBounds(): MultichainSwapBounds {
        const bounds: MultichainSwapBounds = {};

        this.intermediaries.forEach(intermediary => {
            for(let swapType in intermediary.services) {

                const swapService: SwapHandlerInfoType = intermediary.services[swapType];
                bounds[swapType] ??= {};
                const multichainBounds: MultichainTokenBounds = bounds[swapType];
                for(let chainId in swapService.chainTokens) {
                    multichainBounds[chainId] ??= {};
                    const tokenBounds: TokenBounds = multichainBounds[chainId];

                    for(let token of swapService.chainTokens[chainId]) {
                        const tokenMinMax = tokenBounds[token];
                        if(tokenMinMax==null) {
                            tokenBounds[token] = {
                                min: new BN(swapService.min),
                                max: new BN(swapService.max)
                            }
                        } else {
                            tokenMinMax.min = BN.min(tokenMinMax.min, new BN(swapService.min));
                            tokenMinMax.max = BN.min(tokenMinMax.max, new BN(swapService.max));
                        }
                    }
                }
            }
        });

        return bounds;
    }

    /**
     * Returns aggregate swap bounds (in sats - BTC) as indicated by the intermediaries
     */
    getSwapBounds(chainIdentifier: string): SwapBounds {
        const bounds: SwapBounds = {};

        this.intermediaries.forEach(intermediary => {
            for(let swapType in intermediary.services) {

                const swapService: SwapHandlerInfoType = intermediary.services[swapType];
                if(bounds[swapType]==null) bounds[swapType] = {};
                const tokenBounds: TokenBounds = bounds[swapType];

                if(swapService.chainTokens!=null && swapService.chainTokens[chainIdentifier]!=null) {
                    for(let token of swapService.chainTokens[chainIdentifier]) {
                        const tokenMinMax = tokenBounds[token];
                        if(tokenMinMax==null) {
                            tokenBounds[token] = {
                                min: new BN(swapService.min),
                                max: new BN(swapService.max)
                            }
                        } else {
                            tokenMinMax.min = BN.min(tokenMinMax.min, new BN(swapService.min));
                            tokenMinMax.max = BN.min(tokenMinMax.max, new BN(swapService.max));
                        }
                    }
                }
            }
        });

        return bounds;
    }

    /**
     * Returns the aggregate swap minimum (in sats - BTC) for a specific swap type & token
     *  as indicated by the intermediaries
     *
     * @param chainIdentifier
     * @param swapType
     * @param token
     */
    getSwapMinimum(chainIdentifier: string, swapType: SwapType, token: any): number {
        const tokenStr = token.toString();
        return this.intermediaries.reduce<number>((prevMin, intermediary) => {
            const swapService = intermediary.services[swapType];
            if(
                swapService!=null &&
                swapService.chainTokens!=null &&
                swapService.chainTokens[chainIdentifier]!=null &&
                swapService.chainTokens[chainIdentifier].includes(tokenStr)
            ) return prevMin==null ? swapService.min : Math.min(prevMin, swapService.min);
            return prevMin;
        }, null);
    }

    /**
     * Returns the aggregate swap maximum (in sats - BTC) for a specific swap type & token
     *  as indicated by the intermediaries
     *
     * @param chainIdentifier
     * @param swapType
     * @param token
     */
    getSwapMaximum(chainIdentifier: string, swapType: SwapType, token: any): number {
        const tokenStr = token.toString();
        return this.intermediaries.reduce<number>((prevMax, intermediary) => {
            const swapService = intermediary.services[swapType];
            if(
                swapService!=null &&
                swapService.chainTokens!=null &&
                swapService.chainTokens[chainIdentifier]!=null &&
                swapService.chainTokens[chainIdentifier].includes(tokenStr)
            ) return prevMax==null ? swapService.max : Math.max(prevMax, swapService.max);
            return prevMax;
        }, null);
    }

    /**
     * Returns swap candidates for a specific swap type & token address
     *
     * @param chainIdentifier
     * @param swapType
     * @param tokenAddress
     * @param amount Amount to be swapped in sats - BTC
     * @param count How many intermediaries to return at most
     */
    getSwapCandidates(chainIdentifier: string, swapType: SwapType, tokenAddress: any, amount?: BN, count?: number): Intermediary[] {
        const candidates = this.intermediaries.filter(e => {
            const swapService = e.services[swapType];
            if(swapService==null) return false;
            if(amount!=null && amount.lt(new BN(swapService.min))) return false;
            if(amount!=null && amount.gt(new BN(swapService.max))) return false;
            if(swapService.chainTokens==null) return false;
            if(swapService.chainTokens[chainIdentifier]==null) return false;
            if(!swapService.chainTokens[chainIdentifier].includes(tokenAddress.toString())) return false;
            return true;
        });

        candidates.sort(getIntermediaryComparator(swapType, tokenAddress, amount));

        if(count==null) {
            return candidates;
        } else {
            return candidates.slice(0, count);
        }
    }

    /**
     * Removes a specific intermediary from the list of active intermediaries (used for blacklisting)
     *
     * @param intermediary
     */
    removeIntermediary(intermediary: Intermediary): boolean {
        const index = this.intermediaries.indexOf(intermediary);
        if(index>=0) {
            logger.info("removeIntermediary(): Removing intermediary: "+intermediary.url);
            this.intermediaries.splice(index, 1);
            this.emit("removed", [intermediary]);
            return true;
        }
        return false;
    }

}
