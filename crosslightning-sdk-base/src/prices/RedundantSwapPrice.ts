import BN = require("bn.js");
import {IPriceProvider} from "./IPriceProvider";
import {TokenAddress} from "crosslightning-base";
import {ISwapPrice} from "../swaps/ISwapPrice";
import {CoinAddresses} from "./PricesTypes";
import {tryWithRetries} from "../utils/RetryUtils";
import {HttpResponseError} from "../errors/HttpResponseError";
import {BinancePriceProvider} from "./BinancePriceProvider";
import {OKXPriceProvider} from "./OKXPriceProvider";
import {CoinGeckoPriceProvider} from "./CoinGeckoPriceProvider";
import {CoinPaprikaPriceProvider} from "./CoinPaprikaPriceProvider";

function promiseAny(promises: Promise<any>[]): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        let numRejected = 0;
        const rejectReasons = Array(promises.length);

        promises.forEach((promise, index) => {
            promise.then((val) => {
                if(resolve!=null) resolve(val);
                resolve = null;
            }).catch(err => {
                rejectReasons[index] = err;
                numRejected++;
                if(numRejected===promises.length) {
                    reject(rejectReasons);
                }
            })
        })
    });
}

const CACHE_DURATION = 10000;

function objectMap<I, O>(obj: {[key: string]: I}, func: (input: I, key: string) => O): {[key: string]: O} {
    const resp: {[key: string]: O} = {};
    for(let key in obj) {
        resp[key] = func(obj[key], key);
    }
    return resp;
}

export type RedundantSwapPriceAssets = {
    [ticker: string]: {
        binancePair: string,
        okxPair: string,
        coinGeckoCoinId: string,
        coinPaprikaCoinId: string,
        decimals: number
    }
};

export class RedundantSwapPrice extends ISwapPrice {

    static createFromTokenMap(maxAllowedFeeDiffPPM: BN, assets: RedundantSwapPriceAssets, cacheTimeout?: number): RedundantSwapPrice {
        const priceApis = [
            new BinancePriceProvider(objectMap(assets, (input, key) => {
                return input.binancePair==null ? null : {
                    pair: input.binancePair,
                    decimals: input.decimals
                }
            })),
            new OKXPriceProvider(objectMap(assets, (input, key) => {
                return input.okxPair==null ? null : {
                    pair: input.okxPair,
                    decimals: input.decimals
                }
            })),
            new CoinGeckoPriceProvider(objectMap(assets, (input, key) => {
                return input.coinGeckoCoinId==null ? null : {
                    coinId: input.coinGeckoCoinId,
                    decimals: input.decimals
                }
            })),
            new CoinPaprikaPriceProvider(objectMap(assets, (input, key) => {
                return input.coinPaprikaCoinId==null ? null : {
                    coinId: input.coinPaprikaCoinId,
                    decimals: input.decimals
                }
            }))
        ];

        return new RedundantSwapPrice(maxAllowedFeeDiffPPM, objectMap(assets, (input, key) => input.decimals), priceApis, cacheTimeout);
    }

    static create(maxAllowedFeeDiffPPM: BN, cacheTimeout?: number, wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): RedundantSwapPrice {

        const priceApis = [
            new BinancePriceProvider(BinancePriceProvider.createCoinsMap(wbtcAdress, usdcAddress, usdtAddress)),
            new OKXPriceProvider(OKXPriceProvider.createCoinsMap(wbtcAdress, usdcAddress, usdtAddress)),
            new CoinGeckoPriceProvider(CoinGeckoPriceProvider.createCoinsMap(wbtcAdress, usdcAddress, usdtAddress)),
            new CoinPaprikaPriceProvider(CoinPaprikaPriceProvider.createCoinsMap(wbtcAdress, usdcAddress, usdtAddress))
        ];

        return new RedundantSwapPrice(maxAllowedFeeDiffPPM, RedundantSwapPrice.createCoinsMap(wbtcAdress, usdcAddress, usdtAddress), priceApis, cacheTimeout);

    }

    static createFromTokens(maxAllowedFeeDiffPPM: BN, tokens: CoinAddresses, cacheTimeout?: number, nativeTokenTicker?: string): RedundantSwapPrice {

        const priceApis = [
            new BinancePriceProvider(BinancePriceProvider.createCoinsMapFromTokens(tokens, nativeTokenTicker)),
            new OKXPriceProvider(OKXPriceProvider.createCoinsMapFromTokens(tokens, nativeTokenTicker)),
            new CoinGeckoPriceProvider(CoinGeckoPriceProvider.createCoinsMapFromTokens(tokens, nativeTokenTicker)),
            new CoinPaprikaPriceProvider(CoinPaprikaPriceProvider.createCoinsMapFromTokens(tokens, nativeTokenTicker))
        ];

        return new RedundantSwapPrice(maxAllowedFeeDiffPPM, RedundantSwapPrice.createCoinsMapFromTokens(tokens, nativeTokenTicker), priceApis, cacheTimeout);

    }

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): {[key: string]: number} {

        const coinMap = {
            "So11111111111111111111111111111111111111112": 9
        };

        if(wbtcAdress!=null) {
            coinMap[wbtcAdress] = 8;
        }
        if(usdcAddress!=null) {
            coinMap[usdcAddress] = 6;
        }
        if(usdtAddress!=null) {
            coinMap[usdtAddress] = 6;
        }

        return coinMap;

    }

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenTicker?: string): {[key: string]: number} {

        const coinMap: {[key: string]: number} = {};

        if(tokens.WBTC!=null) {
            coinMap[tokens.WBTC] = 8;
        }
        if(tokens.USDC!=null) {
            coinMap[tokens.USDC] = 6;
        }
        if(tokens.USDT!=null) {
            coinMap[tokens.USDT] = 6;
        }
        if(tokens.ETH!=null || nativeTokenTicker!=null) {
            coinMap[tokens.ETH] = 18;
        }

        return coinMap;

    }

    url: string;
    COINS_MAP: {[key: string]: number} = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": 6,
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": 6,
        "So11111111111111111111111111111111111111112": 9,
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": 8
    };

    priceApis: {
        priceApi: IPriceProvider,
        operational: boolean
    }[];

    httpRequestTimeout?: number;

    cache: {
        [tokenAddress: string]: {
            price: Promise<BN>,
            expiry: number
        }
    } = {};
    cacheTimeout: number;

    constructor(maxAllowedFeeDiffPPM: BN, coinsMap: {[key: string]: number}, priceApis: IPriceProvider[], cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.priceApis = priceApis.map(api => {
            return {
                priceApi: api,
                operational: null
            }
        });
        this.cacheTimeout = cacheTimeout || CACHE_DURATION;
    }

    getOperationalPriceApi(): {priceApi: IPriceProvider, operational: boolean} {
        return this.priceApis.find(e => e.operational===true);
    }

    getMaybeOperationalPriceApis(): {priceApi: IPriceProvider, operational: boolean}[] {
        let operational = this.priceApis.filter(e => e.operational===true || e.operational===null);
        if(operational.length===0) {
            this.priceApis.forEach(e => e.operational=null);
            operational = this.priceApis;
        }
        return operational;
    }

    _getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return tryWithRetries(() => {
            const operationalPriceApi = this.getOperationalPriceApi();
            if(operationalPriceApi!=null) {
                return operationalPriceApi.priceApi.getPrice(token, abortSignal).catch(err => {
                    if(abortSignal!=null && abortSignal.aborted) throw err;

                    operationalPriceApi.operational = false;

                    return promiseAny(this.getMaybeOperationalPriceApis().map(obj =>
                        obj.priceApi.getPrice(token, abortSignal).then(price => {
                            obj.operational = true;
                            return price;
                        }).catch(e => {
                            if(abortSignal!=null && abortSignal.aborted) throw e;

                            obj.operational = false;
                            throw e;
                        })
                    )).catch(e => Promise.reject(e.find(err => !(err instanceof HttpResponseError)) || e[0]));
                });
            }
            return promiseAny(this.getMaybeOperationalPriceApis().map(obj =>
                obj.priceApi.getPrice(token, abortSignal).then(price => {
                    console.log("Price from: "+obj.priceApi.constructor.name+": ", price.toString(10));
                    obj.operational = true;
                    return price;
                }).catch(e => {
                    if(abortSignal!=null && abortSignal.aborted) throw e;

                    obj.operational = false;
                    throw e;
                })
            )).catch(e => Promise.reject(e.find(err => !(err instanceof HttpResponseError)) || e[0]));
        }, null, e => e instanceof HttpResponseError, abortSignal);
    }

    /**
     * Returns coin price in mSat
     *
     * @param pair
     * @param invert
     */
    async getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {

        token = token.toString();

        let thisFetch: Promise<BN>;
        const cachedValue = this.cache[token];
        if(cachedValue==null || cachedValue.expiry<Date.now()) {
            thisFetch = this._getPrice(token, abortSignal);
            this.cache[token] = {
                price: thisFetch,
                expiry: Date.now()+this.cacheTimeout
            };
        }

        let price: BN;
        if(thisFetch!=null) {
            price = await thisFetch;
        } else {
            price = await this.cache[token].price.catch(e => this._getPrice(token, abortSignal));
        }

        return price;

    }

    preFetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return this.getPrice(token, abortSignal);
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        if(this.COINS_MAP[toToken.toString()]==null) throw new Error("Token not found!");

        const price = preFetchedPrice || await this.getPrice(toToken, abortSignal);

        return fromAmount
            .mul(new BN(10).pow(new BN(this.COINS_MAP[toToken.toString()])))
            .mul(new BN(1000000)) //To usat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        if(this.COINS_MAP[fromToken.toString()]==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(fromToken, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000000))
            .div(new BN(10).pow(new BN(this.COINS_MAP[fromToken.toString()])));
    }

    shouldIgnore(tokenAddress: TokenAddress): boolean {
        const coin = this.COINS_MAP[tokenAddress.toString()];

        if(coin==null) throw new Error("Token not found");

        return coin===-1;
    }

}