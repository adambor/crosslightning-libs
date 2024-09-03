import {httpGet} from "../../utils/RetryUtils";
import {CoinTypes} from "../abstract/IPriceProvider";
import {ExchangePriceProvider} from "./abstract/ExchangePriceProvider";

export type OKXResponse = {
    code: string;
    msg: string;
    data: [
        {
            instId: string;
            idxPx: string;
            high24h: string;
            sodUtc0: string;
            open24h: string;
            low24h: string;
            sodUtc8: string;
            ts: string;
        }
    ]
};

export class OKXPriceProvider extends ExchangePriceProvider {

    constructor(coinsMap: CoinTypes, url: string = "https://www.okx.com/api/v5", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    async fetchPair(pair: string, abortSignal?: AbortSignal) {
        const response = await httpGet<OKXResponse>(
            this.url+"/market/index-tickers?instId="+pair,
            this.httpRequestTimeout,
            abortSignal
        );

        return parseFloat(response.data[0].idxPx);
    }

}
