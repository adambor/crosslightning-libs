import {ISwapPrice} from "./ISwapPrice";
import {TokenAddress} from "crosslightning-base";
import BN from "bn.js";

const DEFAULT_CACHE_DURATION = 10000;

export abstract class ICachedSwapPrice extends ISwapPrice {

    cache: {
        [tokenAddress: string]: {
            price: Promise<BN>,
            expiry: number
        }
    } = {};
    cacheTimeout: number;

    protected constructor(maxAllowedFeeDiffPPM: BN, cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        this.cacheTimeout = cacheTimeout || DEFAULT_CACHE_DURATION;
    }

    protected abstract fetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN>;

    protected getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        token = token.toString();

        const cachedValue = this.cache[token];
        if(cachedValue!=null && cachedValue.expiry>Date.now()) {
            //Cache still fresh
            return this.cache[token].price.catch(e => this.fetchPrice(token, abortSignal));
        }

        //Refresh cache
        const thisFetch = this.fetchPrice(token);
        this.cache[token] = {
            price: thisFetch,
            expiry: Date.now()+this.cacheTimeout
        };
        thisFetch.catch(e => {
            if(this.cache[token]!=null && this.cache[token].price===thisFetch) delete this.cache[token];
            throw e;
        });
        return thisFetch;
    }

}