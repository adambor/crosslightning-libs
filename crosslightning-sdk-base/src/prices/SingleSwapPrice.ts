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

    /**
     * Fetch price in uSats (micro sats) for a given token against BTC
     * @param token
     * @param abortSignal
     * @protected
     * @returns token price in uSats (micro sats)
     */
    protected fetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return this.priceProvider.getPrice(token, abortSignal);
    }

    /**
     * Returns the decimal places of the specified token, or -1 if token should be ignored, returns null if
     *  token is not found
     *
     * @param token
     * @protected
     */
    protected getDecimals(token: TokenAddress): number | null {
        return this.priceProvider.getDecimals(token.toString());
    }

}
