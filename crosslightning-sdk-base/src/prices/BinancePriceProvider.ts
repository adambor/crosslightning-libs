import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout} from "../utils/RetryUtils";
import {HttpResponseError} from "../errors/HttpResponseError";
import {IPriceProvider} from "./IPriceProvider";
import {CoinAddresses} from "./PricesTypes";

export type BinanceCoinsMapType = {
    [address: string]: {
        pair: string,
        decimals: number
    }
};

export class BinancePriceProvider implements IPriceProvider {

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): BinanceCoinsMapType {

        const coinMap = {
            "So11111111111111111111111111111111111111112": {
                pair: "SOLBTC",
                decimals: 9
            }
        };

        if(wbtcAdress!=null) {
            coinMap[wbtcAdress] = {
                pair: "WBTCBTC",
                decimals: 8
            };
        }
        if(usdcAddress!=null) {
            coinMap[usdcAddress] = {
                pair: "!BTCUSDC",
                decimals: 6
            };
        }
        if(usdtAddress!=null) {
            coinMap[usdtAddress] = {
                pair: "!BTCUSDT",
                decimals: 6
            };
        }

        return coinMap;

    }

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenTicker?: string): BinanceCoinsMapType {

        const coinMap: BinanceCoinsMapType = {};

        if(tokens.WBTC!=null) {
            coinMap[tokens.WBTC] = {
                pair: "WBTCBTC",
                decimals: 8
            };
        }
        if(tokens.USDC!=null) {
            coinMap[tokens.USDC] = {
                pair: "!BTCUSDC",
                decimals: 6
            };
        }
        if(tokens.USDT!=null) {
            coinMap[tokens.USDT] = {
                pair: "!BTCUSDT",
                decimals: 6
            };
        }
        if(tokens.ETH!=null || nativeTokenTicker!=null) {
            coinMap[tokens.ETH] = {
                pair: nativeTokenTicker+"BTC",
                decimals: 18
            };
        }

        return coinMap;

    }

    url: string;
    COINS_MAP: BinanceCoinsMapType = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": {
            pair: "!BTCUSDC",
            decimals: 6
        },
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": {
            pair: "!BTCUSDT",
            decimals: 6
        },
        "So11111111111111111111111111111111111111112": {
            pair: "SOLBTC",
            decimals: 9
        },
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
            pair: "WBTCBTC",
            decimals: 8
        }
    };

    httpRequestTimeout?: number;

    constructor(coinsMap?: BinanceCoinsMapType, url?: string, httpRequestTimeout?: number) {
        this.url = url || "https://api.binance.com/api/v3";
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.httpRequestTimeout = httpRequestTimeout;
    }

    async fetchPrice(pair: string, abortSignal?: AbortSignal) {
        const response: Response = await fetchWithTimeout(this.url+"/ticker/price?symbol="+pair, {
            method: "GET",
            timeout: this.httpRequestTimeout,
            signal: abortSignal
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new HttpResponseError(response.statusText);
            }
            throw new HttpResponseError(resp);
        }

        let jsonBody: any = await response.json();

        return parseFloat(jsonBody.price);
    }

    /**
     * Returns coin price in mSat
     *
     * @param pair
     * @param invert
     */
    async getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {

        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];
        if(coin==null) throw new Error("Token not found");

        const {pair} = coin;

        if(pair.startsWith("$fixed-")) {
            const amt: number = parseFloat(pair.substring(7));
            return new BN(Math.floor(amt*1000000));
        }

        const arr = pair.split(";");

        const promises = [];
        let resultPrice = 1;
        for (let pair of arr) {
            let invert = false
            if (pair.startsWith("!")) {
                invert = true;
                pair = pair.substring(1);
            }
            promises.push(this.fetchPrice(pair).then(price => {
                if (invert) {
                    resultPrice /= price;
                } else {
                    resultPrice *= price;
                }
            }));
        }
        await Promise.all(promises);

        return new BN(Math.floor(resultPrice*100000000000000));

    }

    getDecimals(tokenAddress: TokenAddress): number {
        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return coin.pair==="$ignore" ? -1 : coin.decimals;
    }

}
