import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {IPriceProvider} from "./abstract/IPriceProvider";
import {ICachedSwapPrice} from "./abstract/ICachedSwapPrice";

/**
 * Swap price API using single price source
 */
export class SingleSwapPrice extends ICachedSwapPrice {

    priceProvider: IPriceProvider;

    constructor(maxAllowedFeeDiffPPM: BN, priceProvider: IPriceProvider, cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM, cacheTimeout);
        this.priceProvider = priceProvider;
    }

    protected fetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return this.priceProvider.getPrice(token, abortSignal);
    }

    protected getDecimals(token: TokenAddress): number | null {
        return this.priceProvider.getDecimals(token.toString());
    }

}
