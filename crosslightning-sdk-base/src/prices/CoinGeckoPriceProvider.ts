import {ISwapPrice} from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import {Response} from "cross-fetch";
import {TokenAddress} from "crosslightning-base";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {CoinAddresses} from "./PricesTypes";
import {IPriceProvider} from "./IPriceProvider";
import {CoinGeckoCoinsMapType} from "./CoinGeckoSwapPrice";

export class CoinGeckoPriceProvider implements IPriceProvider {

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
            return new BN(Math.floor(amt*1000));
        }

        const response: Response = await fetchWithTimeout(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=3", {
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

        return new BN(amt*1000);

    }

}
