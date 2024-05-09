import {SwapType} from "../swaps/SwapType";
import {SwapHandlerInfoType} from "./IntermediaryDiscovery";
import * as BN from "bn.js";
import {ChainSwapType, SwapContract} from "crosslightning-base";
import {tryWithRetries} from "../utils/RetryUtils";

export type ServicesType = {
    [key in SwapType]?: SwapHandlerInfoType
};

export type ReputationType = {
    [token: string]: {
        [key in ChainSwapType]: {
            successVolume: BN,
            successCount: BN,
            failVolume: BN,
            failCount: BN,
            coopCloseVolume: BN,
            coopCloseCount: BN,
        }
    }
};

export class Intermediary {

    readonly url: string;
    readonly address: string;
    readonly services: ServicesType;
    reputation: ReputationType;

    constructor(url: string, address: string, services: ServicesType, reputation: ReputationType = {}) {
        this.url = url;
        this.address = address;
        this.services = services;
        this.reputation = reputation;
    }

    async getReputation(swapContract: SwapContract<any, any, any, any>): Promise<ReputationType> {
        const checkReputationTokens: Set<string> = new Set<string>();
        if(this.services[SwapType.TO_BTC]!=null) {
            if(this.services[SwapType.TO_BTC].tokens!=null) for(let token of this.services[SwapType.TO_BTC].tokens) {
                checkReputationTokens.add(token);
            }
        }
        if(this.services[SwapType.TO_BTCLN]!=null) {
            if(this.services[SwapType.TO_BTCLN].tokens!=null) for(let token of this.services[SwapType.TO_BTCLN].tokens) {
                checkReputationTokens.add(token);
            }
        }

        const promises = [];
        const reputation: ReputationType = {};
        for(let token of checkReputationTokens) {
            promises.push(tryWithRetries(() => swapContract.getIntermediaryReputation(this.address, swapContract.toTokenAddress(token))).then(result => {
                reputation[token] = result;
            }));
        }

        try {
            await Promise.all(promises);
        } catch (e) {
            console.error(e);
        }

        this.reputation = reputation;

        return reputation;
    }

}
