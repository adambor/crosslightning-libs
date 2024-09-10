import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {ISwapPrice} from "../swaps/ISwapPrice";

const CACHE_DURATION = 15000;

export class BinanceSwapPrice implements ISwapPrice {

    COINS_MAP: {
        [address: string]: {
            pair: string,
            decimals: number,
            // invert: boolean
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
            // invert: boolean
        }
    } {
        return {
            [usdcAddress]: {
                pair: "!BTCUSDC",
                decimals: 6
            },
            [usdtAddress]: {
                pair: "!BTCUSDT",
                decimals: 6
            },
            [wbtcAddress]: {
                pair: "WBTCBTC",
                decimals: 8
            }
        };
    }

    constructor(url: string, coinmap: {
        [address: string]: {
            pair: string,
            decimals: number,
            // invert: boolean
        }
    });
    constructor(url: string, usdcAddress?: string, usdtAddress?: string, solAddress?: string, wbtcAddress?: string)

    constructor(url: string, usdcAddressOrCoinmap?: string | {
        [address: string]: {
            pair: string,
            decimals: number,
            // invert: boolean
        }
    }, usdtAddress?: string, solAddress?: string, wbtcAddress?: string) {
        this.url = url || "https://api.binance.com/api/v3";
        if(usdcAddressOrCoinmap==null || typeof(usdcAddressOrCoinmap)==="string") {
            this.COINS_MAP = {
                [usdcAddressOrCoinmap as string]: {
                    pair: "!BTCUSDC",
                    decimals: 6,
                    // invert: true
                },
                [usdtAddress]: {
                    pair: "!BTCUSDT",
                    decimals: 6,
                    // invert: true
                },
                [solAddress]: {
                    pair: "SOLBTC",
                    decimals: 9,
                    // invert: false
                },
                [wbtcAddress]: {
                    pair: "WBTCBTC",
                    decimals: 8,
                    // invert: false
                }
            };
        } else {
            this.COINS_MAP = usdcAddressOrCoinmap;
        }
    }

    async fetchPrice(pair: string) {
        const response: Response = await fetch(this.url + "/ticker/price?symbol=" + pair, {
            method: "GET"
        });

        if (response.status !== 200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return parseFloat(jsonBody.price);
    }

    preFetchPrice(token: TokenAddress): Promise<BN> {
        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return this.getPrice(coin.pair);
    }

    /**
     * Returns coin price in micro sat (uSat)
     *
     * @param pair
     */
    async getPrice(pair: string): Promise<BN> {

        if(pair.startsWith("$fixed-")) {
            const amt: number = parseFloat(pair.substring(7));
            return new BN(Math.floor(amt*1000000));
        }

        const arr = pair.split(";");

        const promises = [];
        const cachedValue = this.cache[pair];
        if(cachedValue==null || cachedValue.expiry<Date.now()) {
            let resultPrice = 1;
            for (let pair of arr) {
                let invert = false
                if (pair.startsWith("!")) {
                    invert = true;
                    pair = pair.substring(1);
                }
                const cachedValue = this.cache[pair];
                if (cachedValue == null || cachedValue.expiry < Date.now()) {
                    promises.push(this.fetchPrice(pair).then(price => {
                        this.cache[pair] = {
                            price,
                            expiry: Date.now() + CACHE_DURATION
                        };

                        if (invert) {
                            resultPrice /= price;
                        } else {
                            resultPrice *= price;
                        }
                    }));
                } else {
                    if (invert) {
                        resultPrice /= cachedValue.price;
                    } else {
                        resultPrice *= cachedValue.price;
                    }
                }
            }

            await Promise.all(promises);

            this.cache[pair] = {
                price: resultPrice,
                expiry: Date.now() + CACHE_DURATION
            };
        }

        return new BN(Math.floor(this.cache[pair].price*100000000000000));
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair);

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000000)) //To usat
            .add(roundUp ? price.sub(new BN(1)) : new BN(0))
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair);

        return fromAmount
            .mul(price)
            .div(new BN(10).pow(new BN(coin.decimals)))
            .add(roundUp ? new BN(999999) : new BN(0))
            .div(new BN(1000000));
    }

}
