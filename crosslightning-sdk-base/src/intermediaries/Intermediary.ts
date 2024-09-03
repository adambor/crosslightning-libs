import {SwapType} from "../swaps/SwapType";
import {SwapHandlerInfoType} from "./IntermediaryDiscovery";
import * as BN from "bn.js";
import {ChainSwapType, SwapContract} from "crosslightning-base";
import {LNNodeLiquidity} from "../btc/LightningNetworkApi";
import {tryWithRetries} from "../utils/Utils";

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

export type SCLiquidity = {
    [token: string]: BN
};

export class Intermediary {

    readonly url: string;
    readonly address: string;
    readonly services: ServicesType;
    reputation: ReputationType;
    liquidity: SCLiquidity = {};
    lnData: LNNodeLiquidity;

    constructor(url: string, address: string, services: ServicesType, reputation: ReputationType = {}) {
        this.url = url;
        this.address = address;
        this.services = services;
        this.reputation = reputation;
    }

    /**
     * Returns tokens supported by the intermediary, optionally constrained to the specific swap types
     *
     * @param swapTypesArr
     * @private
     */
    private getSupportedTokens(swapTypesArr: SwapType[] = [
        SwapType.TO_BTC,
        SwapType.TO_BTCLN,
        SwapType.FROM_BTC,
        SwapType.FROM_BTCLN
    ]): Set<string> {
        const swapTypes = new Set(swapTypesArr);
        let tokens: Set<string> = new Set<string>();
        swapTypes.forEach((swapType) => {
            if(this.services[swapType]!=null && this.services[swapType].tokens!=null)
                this.services[swapType].tokens.forEach(token => tokens.add(token));
        });
        return tokens;
    }

    /**
     * Fetches, returns and saves the reputation of the intermediary, either for all or just for a single token
     *
     * @param swapContract
     * @param tokens
     */
    async getReputation(swapContract: SwapContract<any, any, any, any>, tokens?: string[]): Promise<ReputationType> {
        const checkReputationTokens: Set<string> = tokens==null ?
            this.getSupportedTokens([SwapType.TO_BTC, SwapType.TO_BTCLN]) :
            new Set<string>(tokens);

        const promises: Promise<void>[] = [];
        const reputation: ReputationType = {};
        for(let token of checkReputationTokens) {
            promises.push(tryWithRetries(() => swapContract.getIntermediaryReputation(this.address, swapContract.toTokenAddress(token))).then(result => {
                reputation[token] = result;
            }));
        }
        await Promise.all(promises);

        if(this.reputation==null) {
            this.reputation = reputation;
        } else {
            for(let key in reputation) {
                this.reputation[key] = reputation[key];
            }
        }

        return reputation;
    }

}
