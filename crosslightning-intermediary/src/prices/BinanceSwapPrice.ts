import * as BN from "bn.js";
import fetch, {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {ISwapPrice} from "../swaps/ISwapPrice";
import {fetchWithTimeout, tryWithRetries} from "../../../crosslightning-sdk-base/src/utils/RetryUtils";

const CACHE_DURATION = 15000;

export class BinanceSwapPrice implements ISwapPrice {

    COINS_MAP: {
        [address: string]: {
            pair: string,
            decimals: number,
            invert: boolean
        }
    };

    url: string;
    cache: {
        [pair: string]: {
            price: number,
            expiry: number
        }
    } = {};

    /**
     * Generate a new coinmap based on the token addresses of the tokens
     *
     * @param usdcAddress
     * @param usdtAddress
     * @param wbtcAddress
     */
    static generateCoinMap(usdcAddress?: string, usdtAddress?: string, wbtcAddress?: string): {
        [address: string]: {
            pair: string,
            decimals: number,
            invert: boolean
        }
    } {
        return {
            [usdcAddress]: {
                pair: "BTCUSDC",
                decimals: 6,
                invert: true
            },
            [usdtAddress]: {
                pair: "BTCUSDT",
                decimals: 6,
                invert: true
            },
            [wbtcAddress]: {
                pair: "WBTCBTC",
                decimals: 8,
                invert: false
            }
        };
    }

    constructor(url: string, coinmap: {
        [address: string]: {
            pair: string,
            decimals: number,
            invert: boolean
        }
    });
    constructor(url: string, usdcAddress?: string, usdtAddress?: string, solAddress?: string, wbtcAddress?: string)

    constructor(url: string, usdcAddressOrCoinmap?: string | {
        [address: string]: {
            pair: string,
            decimals: number,
            invert: boolean
        }
    }, usdtAddress?: string, solAddress?: string, wbtcAddress?: string) {
        this.url = url || "https://api.binance.com/api/v3";
        if(usdcAddressOrCoinmap==null || typeof(usdcAddressOrCoinmap)==="string") {
            this.COINS_MAP = {
                [usdcAddressOrCoinmap as string]: {
                    pair: "BTCUSDC",
                    decimals: 6,
                    invert: true
                },
                [usdtAddress]: {
                    pair: "BTCUSDT",
                    decimals: 6,
                    invert: true
                },
                [solAddress]: {
                    pair: "SOLBTC",
                    decimals: 9,
                    invert: false
                },
                [wbtcAddress]: {
                    pair: "WBTCBTC",
                    decimals: 8,
                    invert: false
                }
            };
        } else {
            this.COINS_MAP = usdcAddressOrCoinmap;
        }
    }

    preFetchPrice(token: TokenAddress): Promise<BN> {
        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return this.getPrice(coin.pair, coin.invert);
    }

    /**
     * Returns coin price in mSat
     *
     * @param pair
     * @param invert
     */
    async getPrice(pair: string, invert: boolean): Promise<BN> {

        if(pair.startsWith("$fixed-")) {
            const amt: number = parseFloat(pair.substring(7));
            return new BN(Math.floor(amt*1000));
        }

        const cachedValue = this.cache[pair];
        if(cachedValue==null || cachedValue.expiry<Date.now()) {
            const response: Response = await fetchWithTimeout(this.url+"/ticker/price?symbol="+pair, {
                method: "GET"
            });

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

            const price: number = parseFloat(jsonBody.price);

            this.cache[pair] = {
                price,
                expiry: Date.now()+CACHE_DURATION
            };
        }

        let result: BN;
        if(invert) {
            result = new BN(Math.floor((1/this.cache[pair].price)*100000000000));
        } else {
            result = new BN(Math.floor(this.cache[pair].price*100000000000));
        }

        return result;
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair, coin.invert);

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .add(roundUp ? price.sub(new BN(1)) : new BN(0))
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair, coin.invert);

        return fromAmount
            .mul(price)
            .div(new BN(10).pow(new BN(coin.decimals)))
            .add(roundUp ? new BN(999) : new BN(0))
            .div(new BN(1000));
    }

}
