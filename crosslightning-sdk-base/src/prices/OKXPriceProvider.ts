import {ISwapPrice} from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {CoinAddresses} from "./PricesTypes";
import {HttpResponseError} from "../errors/HttpResponseError";
import {IPriceProvider} from "./IPriceProvider";
import {OKXCoinsMapType} from "./OKXSwapPrice";

export class OKXPriceProvider implements IPriceProvider {

    url: string;
    COINS_MAP: OKXCoinsMapType = {
        "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75": {
            pair: "BTC-USDC",
            decimals: 6,
            invert: true
        },
        "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT": {
            pair: "BTC-USDT",
            decimals: 6,
            invert: true
        },
        "So11111111111111111111111111111111111111112": {
            pair: "SOL-BTC",
            decimals: 9,
            invert: false
        },
        "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
            pair: "$fixed-1",
            decimals: 8,
            invert: false
        }
    };

    httpRequestTimeout?: number;

    constructor(coinsMap?: OKXCoinsMapType, url?: string, httpRequestTimeout?: number) {
        this.url = url || "https://www.okx.com/api/v5";
        if(coinsMap!=null) {
            this.COINS_MAP = coinsMap;
        }
        this.httpRequestTimeout = httpRequestTimeout;
    }

    async getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {

        let tokenAddress: string = token.toString();

        const coin = this.COINS_MAP[tokenAddress];
        if(coin==null) throw new Error("Token not found");

        const {pair, invert} = coin;

        const response: Response = await fetchWithTimeout(this.url+"/market/index-tickers?instId="+pair, {
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

        const price =  parseFloat(jsonBody.data[0].idxPx);

        let result: BN;
        if(invert) {
            result = new BN(Math.floor((1/price)*100000000000));
        } else {
            result = new BN(Math.floor(price*100000000000));
        }

        return result;
    }

}
