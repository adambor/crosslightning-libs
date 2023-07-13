import * as BN from "bn.js";
import fetch, {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {ISwapPrice} from "../swaps/ISwapPrice";

const CACHE_DURATION = 15000;

export class CoinGeckoSwapPrice implements ISwapPrice {

    COINS_MAP: {
        [address: string]: {
            coinId: string,
            decimals: number
        }
    };

    url: string;
    cache: {
        [coinId: string]: {
            price: BN,
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
            coinId: string,
            decimals: number
        }
    } {
        return {
            [usdcAddress]: {
                coinId: "usd-coin",
                decimals: 6
            },
            [usdtAddress]: {
                coinId: "tether",
                decimals: 6
            },
            [wbtcAddress]: {
                coinId: "wrapped-bitcoin",
                decimals: 8
            }
        };
    }

    constructor(url: string, coinmap: {
        [address: string]: {
            coinId: string,
            decimals: number
        }
    });
    constructor(url: string, usdcAddress?: string, usdtAddress?: string, solAddress?: string, wbtcAddress?: string)

    constructor(url: string, usdcAddressOrCoinmap?: string | {
        [address: string]: {
            coinId: string,
            decimals: number
        }
    }, usdtAddress?: string, solAddress?: string, wbtcAddress?: string) {
        this.url = url || "https://api.coingecko.com/api/v3";
        if(usdcAddressOrCoinmap==null || typeof(usdcAddressOrCoinmap)==="string") {
            this.COINS_MAP = {
                [usdcAddressOrCoinmap as string]: {
                    coinId: "usd-coin",
                    decimals: 6
                },
                [usdtAddress]: {
                    coinId: "tether",
                    decimals: 6
                },
                [solAddress]: {
                    coinId: "solana",
                    decimals: 9
                },
                [wbtcAddress]: {
                    coinId: "wrapped-bitcoin",
                    decimals: 8
                }
            };
        } else {
            this.COINS_MAP = usdcAddressOrCoinmap;
        }
    }

    /**
     * Returns coin price in mSat
     *
     * @param coinId
     */
    async getPrice(coinId: string): Promise<BN> {

        if(coinId.startsWith("$fixed-")) {
            const amt: number = parseFloat(coinId.substring(7));
            return new BN(Math.floor(amt*1000));
        }

        const cachedValue = this.cache[coinId];
        if(cachedValue!=null && cachedValue.expiry>Date.now()) {
            return cachedValue.price;
        }

        const response: Response = await fetch(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=3", {
            method: "GET",
            headers: {'Content-Type': 'application/json'}
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

        const amt: number = jsonBody[coinId].sats;

        const result = new BN(amt*1000);

        this.cache[coinId] = {
            price: result,
            expiry: Date.now()+CACHE_DURATION
        };

        return result;
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, roundUp?: boolean): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .add(roundUp ? price.sub(new BN(1)) : new BN(0))
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, roundUp?: boolean): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(price)
            .div(new BN(10).pow(new BN(coin.decimals)))
            .add(roundUp ? new BN(999) : new BN(0))
            .div(new BN(1000));
    }

}
