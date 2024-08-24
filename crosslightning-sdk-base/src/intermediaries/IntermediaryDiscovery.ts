import {Intermediary, ServicesType} from "./Intermediary";
import {SwapType} from "../swaps/SwapType";
import * as BN from "bn.js";
import {SwapData, TokenAddress} from "crosslightning-base";
import {SwapContract} from "crosslightning-base/dist";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {AbortError} from "../errors/AbortError";
import {EventEmitter} from "events";
import {randomBytesBuffer} from "../utils/Utils";
import {Buffer} from "buffer";

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
    data?: any,
    tokens: string[]
};

type InfoHandlerResponseEnvelope = {
    nonce: string,
    services: {
        [key in SwapHandlerType]?: SwapHandlerInfoType
    }
};

type InfoHandlerResponse = {
    address: string,
    envelope: string,
    signature: string
};

export type TokenBounds = {
    [token: string]: {
        min: BN,
        max: BN
    }
}

export type SwapBounds = {
    [key in SwapType]?: TokenBounds
}

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
function getIntermediaryComparator(swapType: SwapType, tokenAddress: TokenAddress, swapAmount?: BN) {

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

const REGISTRY_URL = "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry.json?ref=main";
const BATCH_SIZE = 20;
const TIMEOUT = 3000;

export class IntermediaryDiscovery<T extends SwapData> extends EventEmitter {

    intermediaries: Intermediary[];

    swapContract: SwapContract<T, any, any, any>;
    registryUrl: string;

    httpRequestTimeout?: number;

    private overrideNodeUrls?: string[];

    constructor(swapContract: SwapContract<T, any, any, any>, registryUrl?: string, nodeUrls?: string[], httpRequestTimeout?: number) {
        super();
        this.swapContract = swapContract;
        this.registryUrl = registryUrl || REGISTRY_URL;
        this.overrideNodeUrls = nodeUrls;
        this.httpRequestTimeout = httpRequestTimeout;
    }

    async getIntermediaryUrls(abortSignal?: AbortSignal): Promise<string[]> {

        if(this.overrideNodeUrls!=null && this.overrideNodeUrls.length>0) {
            return this.overrideNodeUrls;
        }

        const response: Response = await tryWithRetries(() => {
            return fetchWithTimeout(this.registryUrl, {
                method: "GET",
                headers: {'Content-Type': 'application/json'},
                signal: abortSignal,
                timeout: this.httpRequestTimeout
            })
        }, null, null, abortSignal);

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        const content = jsonBody.content.replace(new RegExp("\\n", "g"), "");
        console.log(content);

        const urls: string[] = JSON.parse(Buffer.from(content, "base64").toString());

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        return urls;

    }

    async getNodeInfo(url: string, abortSignal?: AbortSignal) : Promise<{address: string, info: InfoHandlerResponseEnvelope}> {

        const nonce = (await randomBytesBuffer(32)).toString("hex");

        const response: Response = await fetchWithTimeout(url+"/info", {
            method: "POST",
            body: JSON.stringify({
                nonce
            }),
            headers: {'Content-Type': 'application/json'},
            signal: abortSignal,
            timeout: this.httpRequestTimeout
        });

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: InfoHandlerResponse = await response.json();
        const info: InfoHandlerResponseEnvelope = JSON.parse(jsonBody.envelope);

        if(nonce!==info.nonce) throw new Error("Invalid response - nonce");

        await this.swapContract.isValidDataSignature(Buffer.from(jsonBody.envelope), jsonBody.signature, jsonBody.address);

        console.log("Returned info: ", info);

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        return {
            address: jsonBody.address,
            info
        };

    }

    async fetchIntermediaries(abortSignal?: AbortSignal): Promise<Intermediary[]> {
        const urls = await this.getIntermediaryUrls(abortSignal);

        const activeNodes: {
            url: string,
            address: string,
            info: InfoHandlerResponseEnvelope
        }[] = [];

        let promises = [];
        for(let url of urls) {
            promises.push(this.getNodeInfo(url, abortSignal).then((resp) => {
                activeNodes.push({
                    address: resp.address,
                    url,
                    info: resp.info,
                })
            }).catch(e => console.error(e)));
            if(promises.length>=BATCH_SIZE) {
                await Promise.all(promises);
                promises = [];
            }
        }

        if(promises.length>0) await Promise.all(promises);

        if(activeNodes.length===0) throw new Error("No online intermediary found!");

        return activeNodes.map(node => {
            const services: ServicesType = {};
            for(let key in node.info.services) {
                services[swapHandlerTypeToSwapType(key as SwapHandlerType)] = node.info.services[key];
            }
            return new Intermediary(node.url, node.address, services);
        });
    }

    async reloadIntermediaries(abortSignal?: AbortSignal): Promise<void> {

        const fetchedIntermediaries = await tryWithRetries<Intermediary[]>(() => this.fetchIntermediaries(abortSignal), null, null, abortSignal);
        this.intermediaries = fetchedIntermediaries;
        this.emit("added", fetchedIntermediaries);

        console.log("Reloaded intermediaries: ", this.intermediaries);

    }

    async init(abortSignal?: AbortSignal): Promise<void> {

        const fetchedIntermediaries = await tryWithRetries<Intermediary[]>(() => this.fetchIntermediaries(abortSignal), null, null, abortSignal);
        this.intermediaries = fetchedIntermediaries;
        this.emit("added", fetchedIntermediaries);

        console.log("Swap intermediaries: ", this.intermediaries);

    }

    getSwapBounds(): SwapBounds {
        const bounds: SwapBounds = {};

        this.intermediaries.forEach(intermediary => {
            for(let swapType in intermediary.services) {

                const swapService: SwapHandlerInfoType = intermediary.services[swapType];
                if(bounds[swapType]==null) bounds[swapType] = {};
                const tokenBounds: TokenBounds = bounds[swapType];

                for(let token of swapService.tokens) {
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
        });

        return bounds;
    }

    getSwapMinimum(swapType: SwapType, token: TokenAddress): number {
        let min;
        const tokenStr = token.toString();
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null && swapService.tokens.includes(tokenStr)) {
                min==null ? min = swapService.min : min = Math.min(min, swapService.min);
            }
        });
        return min;
    }

    getSwapMaximum(swapType: SwapType, token: TokenAddress): number {
        let max;
        const tokenStr = token.toString();
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null && swapService.tokens.includes(tokenStr)) {
                max==null ? max = swapService.max : max = Math.max(max, swapService.max);
            }
        });
        return max;
    }

    getSwapCandidates(swapType: SwapType, tokenAddress: TokenAddress, amount?: BN, count?: number): Intermediary[] {

        const candidates = this.intermediaries.filter(e => {
            const swapService = e.services[swapType];
            if(swapService==null) return false;
            if(amount!=null && amount.lt(new BN(swapService.min))) return false;
            if(amount!=null && amount.gt(new BN(swapService.max))) return false;
            if(swapService.tokens==null) return false;
            if(!swapService.tokens.includes(tokenAddress.toString())) return false;
            return true;
        });

        candidates.sort(getIntermediaryComparator(swapType, tokenAddress, amount));

        if(count==null) {
            return candidates;
        }

        const result = [];

        for(let i=0;i<count && i<candidates.length;i++) {
            result.push(candidates[i]);
        }

        return result;

    }

    removeIntermediary(intermediary: Intermediary): boolean {
        const index = this.intermediaries.indexOf(intermediary);
        if(index>=0) {
            this.intermediaries.splice(index, 1);
            this.emit("removed", [intermediary]);
            return true;
        }
        return false;
    }

}
