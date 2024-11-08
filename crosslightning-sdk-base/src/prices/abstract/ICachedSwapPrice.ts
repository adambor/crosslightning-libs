import {ISwapPrice} from "./ISwapPrice";
import BN from "bn.js";
import {ChainIds, MultiChain} from "../../swaps/Swapper";

const DEFAULT_CACHE_DURATION = 10000;

export abstract class ICachedSwapPrice<T extends MultiChain> extends ISwapPrice<T> {

    cache: {
        [chainIdentifier in keyof T]?: {
            [tokenAddress: string]: {
                price: Promise<BN>,
                expiry: number
            }
        }
    } = {};
    cacheTimeout: number;

    protected constructor(maxAllowedFeeDiffPPM: BN, cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        this.cacheTimeout = cacheTimeout || DEFAULT_CACHE_DURATION;
    }

    protected abstract fetchPrice<C extends ChainIds<T>>(chainIdentifier: C, token: string, abortSignal?: AbortSignal): Promise<BN>;

    protected getPrice<C extends ChainIds<T>>(chainIdentifier: C, tokenAddress: string, abortSignal?: AbortSignal): Promise<BN> {
        const token = tokenAddress.toString();

        const chainCache = this.cache[chainIdentifier];
        if(chainCache!=null) {
            const cachedValue = chainCache[token];
            if(cachedValue!=null && cachedValue.expiry>Date.now()) {
                //Cache still fresh
                return cachedValue.price.catch(e => this.fetchPrice(chainIdentifier, token, abortSignal));
            }
        }

        //Refresh cache
        const thisFetch = this.fetchPrice(chainIdentifier, token);
        this.cache[chainIdentifier] ??= {};
        (this.cache[chainIdentifier] as any)[token] = {
            price: thisFetch,
            expiry: Date.now()+this.cacheTimeout
        };
        thisFetch.catch(e => {
            if(
                this.cache[chainIdentifier]!=null &&
                this.cache[chainIdentifier][token]!=null &&
                this.cache[chainIdentifier][token].price===thisFetch
            ) delete this.cache[token];
            throw e;
        });
        return thisFetch;
    }

}