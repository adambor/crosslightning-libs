import {CoinType, CoinTypes, IPriceProvider} from "../abstract/IPriceProvider";
import * as BN from "bn.js";
import {httpGet} from "../../utils/RetryUtils";
import {HttpPriceProvider} from "./abstract/HttpPriceProvider";

export type CoinPaprikaResponse = {
    quotes: {
        BTC: {
            price: number
        }
    }
};

export class CoinPaprikaPriceProvider extends HttpPriceProvider {

    constructor(coinsMap: CoinTypes, url: string = "https://api.coinpaprika.com/v1", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    async fetchPrice(token: CoinType, abortSignal?: AbortSignal) {
        const response = await httpGet<CoinPaprikaResponse>(
            this.url+"/tickers/"+token.coinId+"?quotes=BTC",
            this.httpRequestTimeout,
            abortSignal
        );

        return new BN(response.quotes.BTC.price*100000000000000);
    }

}