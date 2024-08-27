import {ISwapPrice} from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {CoinAddresses} from "./PricesTypes";
import {HttpResponseError} from "../errors/HttpResponseError";
import {BinancePriceProvider} from "./BinancePriceProvider";
import {IPriceProvider} from "./IPriceProvider";

const CACHE_DURATION = 10000;

export class SingleSwapPrice extends ISwapPrice {

    cache: {
        [pair: string]: {
            price: BN,
            expiry: number
        }
    } = {};
    cacheTimeout: number;
    priceProvider: IPriceProvider;

    constructor(maxAllowedFeeDiffPPM: BN, priceProvider: IPriceProvider, cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        this.cacheTimeout = cacheTimeout || CACHE_DURATION;
        this.priceProvider = priceProvider;
    }

    /**
     * Returns coin price in mSat
     *
     * @param token
     * @param abortSignal
     */
    async getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {

        const cachedValue = this.cache[token.toString()];
        if(cachedValue==null || cachedValue.expiry<Date.now()) {
            const price = await this.priceProvider.getPrice(token, abortSignal);
            this.cache[token.toString()] = {
                price,
                expiry: Date.now()+this.cacheTimeout
            };
        }

        return cachedValue.price;

    }

    preFetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return this.getPrice(token, abortSignal);
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        const price = preFetchedPrice || await this.getPrice(toToken, abortSignal);

        return fromAmount
            .mul(new BN(10).pow(new BN(this.priceProvider.getDecimals(toToken))))
            .mul(new BN(1000000)) //To usat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        const price = preFetchedPrice || await this.getPrice(fromToken, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000000))
            .div(new BN(10).pow(new BN(this.priceProvider.getDecimals(fromToken))));
    }

    shouldIgnore(tokenAddress: TokenAddress): boolean {
        return this.priceProvider.getDecimals(tokenAddress)===-1;
    }

}
