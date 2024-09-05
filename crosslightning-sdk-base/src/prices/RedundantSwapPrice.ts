import BN = require("bn.js");
import {IPriceProvider} from "./abstract/IPriceProvider";
import {TokenAddress} from "crosslightning-base";
import {BinancePriceProvider} from "./providers/BinancePriceProvider";
import {OKXPriceProvider} from "./providers/OKXPriceProvider";
import {CoinGeckoPriceProvider} from "./providers/CoinGeckoPriceProvider";
import {CoinPaprikaPriceProvider} from "./providers/CoinPaprikaPriceProvider";
import {promiseAny, objectMap, tryWithRetries} from "../utils/Utils";
import {ICachedSwapPrice} from "./abstract/ICachedSwapPrice";
import {RequestError} from "../errors/RequestError";

export type RedundantSwapPriceAssets = {
    [ticker: string]: {
        binancePair: string,
        okxPair: string,
        coinGeckoCoinId: string,
        coinPaprikaCoinId: string,
        decimals: number
    }
};

/**
 * Swap price API using multiple price sources, handles errors on the APIs and automatically switches between them, such
 *  that there always is a functional API
 */
export class RedundantSwapPrice extends ICachedSwapPrice {

    static createFromTokenMap(maxAllowedFeeDiffPPM: BN, assets: RedundantSwapPriceAssets, cacheTimeout?: number): RedundantSwapPrice {
        const priceApis = [
            new BinancePriceProvider(objectMap(assets, (input, key) => {
                return input.binancePair==null ? null : {
                    coinId: input.binancePair,
                    decimals: input.decimals
                }
            })),
            new OKXPriceProvider(objectMap(assets, (input, key) => {
                return input.okxPair==null ? null : {
                    coinId: input.okxPair,
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

    coinsDecimals: {[key: string]: number} = {};
    priceApis: {
        priceApi: IPriceProvider,
        operational: boolean
    }[];

    constructor(maxAllowedFeeDiffPPM: BN, coinsDecimals: {[key: string]: number}, priceApis: IPriceProvider[], cacheTimeout?: number) {
        super(maxAllowedFeeDiffPPM, cacheTimeout);
        this.coinsDecimals = coinsDecimals;
        this.priceApis = priceApis.map(api => {
            return {
                priceApi: api,
                operational: null
            }
        });
    }

    /**
     * Returns price api that should be operational
     *
     * @private
     */
    private getOperationalPriceApi(): {priceApi: IPriceProvider, operational: boolean} {
        return this.priceApis.find(e => e.operational===true);
    }

    /**
     * Returns price apis that are maybe operational, in case none is considered operational returns all of the price
     *  apis such that they can be tested again whether they are operational
     *
     * @private
     */
    private getMaybeOperationalPriceApis(): {priceApi: IPriceProvider, operational: boolean}[] {
        let operational = this.priceApis.filter(e => e.operational===true || e.operational===null);
        if(operational.length===0) {
            this.priceApis.forEach(e => e.operational=null);
            operational = this.priceApis;
        }
        return operational;
    }

    /**
     * Fetches price in parallel from multiple maybe operational price APIs
     *
     * @param token
     * @param abortSignal
     * @private
     */
    private async fetchPriceFromMaybeOperationalPriceApis(token: TokenAddress, abortSignal?: AbortSignal) {
        try {
            return await promiseAny<BN>(this.getMaybeOperationalPriceApis().map(
                obj => obj.priceApi.getPrice(token, abortSignal).then(price => {
                    console.log("Price from: "+obj.priceApi.constructor.name+": ", price.toString(10));
                    obj.operational = true;
                    return price;
                }).catch(e => {
                    if(abortSignal!=null && abortSignal.aborted) throw e;
                    obj.operational = false;
                    throw e;
                })
            ))
        } catch (e) {
            throw e.find(err => !(err instanceof RequestError)) || e[0];
        }
    }

    /**
     * Fetches the prices, first tries to use the operational price API (if any) and if that fails it falls back
     *  to using maybe operational price APIs
     *
     * @param token
     * @param abortSignal
     * @private
     */
    protected fetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return tryWithRetries(() => {
            const operationalPriceApi = this.getOperationalPriceApi();
            if(operationalPriceApi!=null) {
                return operationalPriceApi.priceApi.getPrice(token, abortSignal).catch(err => {
                    if(abortSignal!=null && abortSignal.aborted) throw err;
                    operationalPriceApi.operational = false;
                    return this.fetchPriceFromMaybeOperationalPriceApis(token, abortSignal);
                });
            }
            return this.fetchPriceFromMaybeOperationalPriceApis(token, abortSignal);
        }, null, RequestError, abortSignal);
    }

    protected getDecimals(token: TokenAddress): number | null {
        return this.coinsDecimals[token.toString()];
    }

}