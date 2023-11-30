import {Intermediary, ServicesType} from "./Intermediary";
import {Response} from "cross-fetch";
import {randomBytes} from "crypto-browserify";
import {SwapType} from "../swaps/SwapType";
import * as BN from "bn.js";
import {SwapData, TokenAddress} from "crosslightning-base";
import {SwapContract} from "crosslightning-base/dist";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {AbortError} from "../errors/AbortError";

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
const BATCH_SIZE = 10;
const TIMEOUT = 3000;

export class IntermediaryDiscovery<T extends SwapData> {

    intermediaries: Intermediary[];

    swapContract: SwapContract<T, any>;
    registryUrl: string;

    httpRequestTimeout?: number;

    private overrideNodeUrls?: string[];

    constructor(swapContract: SwapContract<T, any>, registryUrl?: string, nodeUrls?: string[], httpRequestTimeout?: number) {
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

        const nonce = randomBytes(32).toString("hex");

        const response: Response = await tryWithRetries(() => {
            return fetchWithTimeout(url+"/info", {
                method: "POST",
                body: JSON.stringify({
                    nonce
                }),
                headers: {'Content-Type': 'application/json'},
                signal: abortSignal,
                timeout: this.httpRequestTimeout
            })
        },null, null, abortSignal);

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

    async getReputation(node: {
        url: string,
        address: string,
        info: InfoHandlerResponseEnvelope
    }) {
        const checkReputationTokens: Set<string> = new Set<string>();
        if(node.info.services.TO_BTC!=null) {
            if(node.info.services.TO_BTC.tokens!=null) for(let token of node.info.services.TO_BTC.tokens) {
                checkReputationTokens.add(token);
            }
        }
        if(node.info.services.TO_BTCLN!=null) {
            if(node.info.services.TO_BTCLN.tokens!=null) for(let token of node.info.services.TO_BTCLN.tokens) {
                checkReputationTokens.add(token);
            }
        }

        const promises = [];
        const reputation = {};
        for(let token of checkReputationTokens) {
            promises.push(tryWithRetries(() => this.swapContract.getIntermediaryReputation(node.address, this.swapContract.toTokenAddress(token))).then(result => {
                reputation[token] = result;
            }));
        }

        try {
            await Promise.all(promises);
        } catch (e) {
            console.error(e);
        }

        return reputation;
    }

    async init(abortSignal?: AbortSignal) {

        this.intermediaries = [];

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

        promises = [];
        for(let node of activeNodes) {
            //Fetch reputation
            promises.push(this.getReputation(node).then(reputation => {
                const services: ServicesType = {};

                for(let key in node.info.services) {
                    services[swapHandlerTypeToSwapType(key as SwapHandlerType)] = node.info.services[key];
                }

                this.intermediaries.push(new Intermediary(node.url, node.address, services, reputation));
            }));

            if(promises.length>=BATCH_SIZE) {
                await Promise.all(promises);
                promises = [];
            }
        }

        if(promises.length>0) await Promise.all(promises);

        console.log("Swap intermediaries: ", this.intermediaries);

    }

    getSwapMinimum(swapType: SwapType): number {
        let min;
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null) {
                min==null ? min = swapService.min : min = Math.min(min, swapService.min);
            }
        });
        return min;
    }

    getSwapMaximum(swapType: SwapType): number {
        let max;
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null) {
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
            return true;
        }
        return false;
    }

}
