import {ISwapPrice} from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {CoinAddresses} from "./PricesTypes";

export type BinanceCoinsMapType = {
    [address: string]: {
        pair: string,
        decimals: number,
        invert: boolean
    }
};

export class BinanceSwapPrice extends ISwapPrice {

    static createCoinsMap(wbtcAdress?: string, usdcAddress?: string, usdtAddress?: string): BinanceCoinsMapType {

        const coinMap = {
            "So11111111111111111111111111111111111111112": {
                pair: "SOLBTC",
                decimals: 9,
                invert: false
            }
        };

        if(wbtcAdress!=null) {
            coinMap[wbtcAdress] = {
                pair: "WBTCBTC",
                decimals: 8,
                invert: false
            };
        }
        if(usdcAddress!=null) {
            coinMap[usdcAddress] = {
                pair: "BTCUSDC",
                decimals: 6,
                invert: true
            };
        }
        if(usdtAddress!=null) {
            coinMap[usdtAddress] = {
                pair: "BTCUSDT",
                decimals: 6,
                invert: true
            };
        }

        return coinMap;

    }

    static createCoinsMapFromTokens(tokens: CoinAddresses, nativeTokenTicker?: string): BinanceCoinsMapType {

        const coinMap: BinanceCoinsMapType = {};

        if(tokens.WBTC!=null) {
            coinMap[tokens.WBTC] = {
                pair: "WBTCBTC",
                decimals: 8,
                invert: false
            };
        }
        if(tokens.USDC!=null) {
            coinMap[tokens.USDC] = {
                pair: "BTCUSDC",
                decimals: 6,
                invert: true
            };
        }
        if(tokens.USDT!=null) {
            coinMap[tokens.USDT] = {
                pair: "BTCUSDT",
                decimals: 6,
                invert: true
            };
        }
        if(tokens.ETH!=null || nativeTokenTicker!=null) {
            coinMap[tokens.ETH] = {
                pair: nativeTokenTicker+"BTC",
                decimals: 18,
                invert: false
            };
        }

        return coinMap;

    }

    url: string;
    COINS_MAP: BinanceCoinsMapType = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": {
            pair: "BTCUSDC",
            decimals: 6,
            invert: true
        },
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": {
            pair: "BTCUSDT",
            decimals: 6,
            invert: true
        },
        "So11111111111111111111111111111111111111112": {
            pair: "SOLBTC",
            decimals: 9,
            invert: false
        },
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
            pair: "WBTCBTC",
            decimals: 8,
            invert: false
        }
    };

    httpRequestTimeout?: number;

    constructor(maxAllowedFeeDiffPPM: BN, coinsMap?: BinanceCoinsMapType, url?: string, httpRequestTimeout?: number) {
        super(maxAllowedFeeDiffPPM);
        this.url = url || "https://api.binance.com/api/v3";
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.httpRequestTimeout = httpRequestTimeout;
    }

    /**
     * Returns coin price in mSat
     *
     * @param pair
     * @param invert
     */
    async getPrice(pair: string, invert: boolean, abortSignal?: AbortSignal): Promise<BN> {

        if(pair.startsWith("$fixed-")) {
            const amt: number = parseFloat(pair.substring(7));
            return new BN(Math.floor(amt*1000));
        }

        const response: Response = await tryWithRetries(() => fetchWithTimeout(this.url+"/ticker/price?symbol="+pair, {
            method: "GET",
            timeout: this.httpRequestTimeout,
            signal: abortSignal
        }), null ,null, abortSignal);

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

        const amt: number = parseFloat(jsonBody.price);

        if(invert) {
            return new BN(Math.floor((1/amt)*100000000000));
        }
        return new BN(Math.floor(amt*100000000000));

    }

    preFetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");
        return this.getPrice(coin.pair, coin.invert, abortSignal);
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair, coin.invert, abortSignal);

        console.log("Swap price: ", price.toString(10));

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(coin.pair, coin.invert, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000))
            .div(new BN(10).pow(new BN(coin.decimals)));
    }

    shouldIgnore(tokenAddress: TokenAddress): boolean {
        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        return coin.pair==="$ignore";
    }

}
