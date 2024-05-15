import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout} from "../utils/RetryUtils";
import {IPriceProvider} from "./IPriceProvider";
import {CoinAddresses} from "./PricesTypes";

export type CoinGeckoCoinsMapType = {
    [address: string]: {
        coinId: string,
        decimals: number
    }
};

export class CoinGeckoPriceProvider implements IPriceProvider {

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): CoinGeckoCoinsMapType {

        const coinMap = {
            "So11111111111111111111111111111111111111112": {
                coinId: "solana",
                decimals: 9
            }
        };

        if(wbtcAdress!=null) {
            coinMap[wbtcAdress] = {
                coinId: "wrapped-bitcoin",
                decimals: 8
            };
        }
        if(usdcAddress!=null) {
            coinMap[usdcAddress] = {
                coinId: "usd-coin",
                decimals: 6
            };
        }
        if(usdtAddress!=null) {
            coinMap[usdtAddress] = {
                coinId: "tether",
                decimals: 6
            };
        }

        return coinMap;

    }

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenCoinGeckoId?: string): CoinGeckoCoinsMapType {

        const coinMap = {};

        if(tokens.WBTC!=null) {
            coinMap[tokens.WBTC] = {
                coinId: "wrapped-bitcoin",
                decimals: 8
            };
        }
        if(tokens.USDC!=null) {
            coinMap[tokens.USDC] = {
                coinId: "usd-coin",
                decimals: 6
            };
        }
        if(tokens.USDT!=null) {
            coinMap[tokens.USDT] = {
                coinId: "tether",
                decimals: 6
            };
        }
        if(tokens.ETH!=null || nativeTokenCoinGeckoId!=null) {
            coinMap[tokens.ETH] = {
                coinId: nativeTokenCoinGeckoId,
                decimals: 18
            };
        }

        return coinMap;

    }

    url: string;
    COINS_MAP: CoinGeckoCoinsMapType = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": {
            coinId: "usd-coin",
            decimals: 6
        },
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": {
            coinId: "tether",
            decimals: 6
        },
        "So11111111111111111111111111111111111111112": {
            coinId: "solana",
            decimals: 9
        },
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
            coinId: "wrapped-bitcoin",
            decimals: 8
        }
    };

    httpRequestTimeout?: number;

    constructor(coinsMap?: CoinGeckoCoinsMapType, url?: string, httpRequestTimeout?: number) {
        this.url = url || "https://api.coingecko.com/api/v3";
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
            return new BN(Math.floor(amt*1000000));
        }

        const response: Response = await fetchWithTimeout(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=6", {
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

        const amt: number = jsonBody[coinId].sats;

        return new BN(amt*1000000);

    }

    getDecimals(tokenAddress: TokenAddress): number {
        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return coin.coinId==="$ignore" ? -1 : coin.decimals;
    }

}
