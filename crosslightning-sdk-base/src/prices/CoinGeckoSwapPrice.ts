import {ISwapPrice} from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import fetch, {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {timeoutSignal} from "../utils/RetryUtils";


export type CoinsMapType = {
    [address: string]: {
        coinId: string,
        decimals: number
    }
};

export type CoinAddresses = {
    [token in "USDC" | "USDT" | "WBTC" | "ETH"]?: string;
};

export class CoinGeckoSwapPrice extends ISwapPrice {

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): CoinsMapType {

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

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenCoinGeckoId?: string): CoinsMapType {

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
    COINS_MAP: CoinsMapType = {
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

    constructor(maxAllowedFeeDiffPPM: BN, coinsMap?: CoinsMapType, url?: string, httpRequestTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        this.url = url || "https://api.coingecko.com/api/v3";
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.httpRequestTimeout = httpRequestTimeout;
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

        const response: Response = await fetch(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=3", {
            method: "GET",
            signal: timeoutSignal(this.httpRequestTimeout)
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

        return new BN(amt*1000);

    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        console.log("Swap price: ", price.toString(10));

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(price)
            .div(new BN(1000))
            .div(new BN(10).pow(new BN(coin.decimals)));
    }

    shouldIgnore(tokenAddress: TokenAddress): boolean {
        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return coin.coinId==="$ignore";
    }

}
