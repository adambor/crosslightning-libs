import {IPriceProvider} from "./IPriceProvider";
import {CoinAddresses} from "./PricesTypes";
import * as BN from "bn.js";
import {Response} from "cross-fetch";
import {fetchWithTimeout} from "../utils/RetryUtils";
import {TokenAddress} from "crosslightning-base";

export type CoinPaprikaCoinsMapType = {
    [address: string]: {
        coinId: string,
        decimals: number
    }
};

export class CoinPaprikaPriceProvider implements IPriceProvider {

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): CoinPaprikaCoinsMapType {

        const coinMap = {
            "So11111111111111111111111111111111111111112": {
                coinId: "sol-solana",
                decimals: 9
            }
        };

        if(wbtcAdress!=null) {
            coinMap[wbtcAdress] = {
                coinId: "wbtc-wrapped-bitcoin",
                decimals: 8
            };
        }
        if(usdcAddress!=null) {
            coinMap[usdcAddress] = {
                coinId: "usdc-usd-coin",
                decimals: 6
            };
        }
        if(usdtAddress!=null) {
            coinMap[usdtAddress] = {
                coinId: "usdt-tether",
                decimals: 6
            };
        }

        return coinMap;

    }

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenCoinPaprikaId?: string): CoinPaprikaCoinsMapType {

        const coinMap = {};

        if(tokens.WBTC!=null) {
            coinMap[tokens.WBTC] = {
                coinId: "wbtc-wrapped-bitcoin",
                decimals: 8
            };
        }
        if(tokens.USDC!=null) {
            coinMap[tokens.USDC] = {
                coinId: "usdc-usd-coin",
                decimals: 6
            };
        }
        if(tokens.USDT!=null) {
            coinMap[tokens.USDT] = {
                coinId: "usdt-tether",
                decimals: 6
            };
        }
        if(tokens.ETH!=null || nativeTokenCoinPaprikaId!=null) {
            coinMap[tokens.ETH] = {
                coinId: nativeTokenCoinPaprikaId,
                decimals: 18
            };
        }

        return coinMap;

    }

    url: string;
    COINS_MAP: CoinPaprikaCoinsMapType = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": {
            coinId: "usdc-usd-coin",
            decimals: 6
        },
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": {
            coinId: "usdt-tether",
            decimals: 6
        },
        "So11111111111111111111111111111111111111112": {
            coinId: "sol-solana",
            decimals: 9
        },
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
            coinId: "wbtc-wrapped-bitcoin",
            decimals: 8
        }
    };

    httpRequestTimeout?: number;


    constructor(coinsMap?: CoinPaprikaCoinsMapType, url?: string, httpRequestTimeout?: number) {
        this.url = url || "https://api.coinpaprika.com/v1";
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.httpRequestTimeout = httpRequestTimeout;
    }

    async getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {

        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];
        if(coin==null) throw new Error("Token not found");

        const coinId = coin.coinId;

        if(coinId.startsWith("$fixed-")) {
            const amt: number = parseFloat(coinId.substring(7));
            return new BN(Math.floor(amt*1000));
        }

        const response: Response = await fetchWithTimeout(this.url+"/tickers/"+coinId+"?quotes=BTC", {
            method: "GET",
            timeout: this.httpRequestTimeout,
            signal: abortSignal
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

        const amt: number = jsonBody.quotes.BTC.price;

        return new BN(amt*100000000000);

    }

}