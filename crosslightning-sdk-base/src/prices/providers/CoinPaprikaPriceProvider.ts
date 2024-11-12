import {CoinType, CtorCoinTypes} from "../abstract/IPriceProvider";
import * as BN from "bn.js";
import {HttpPriceProvider} from "./abstract/HttpPriceProvider";
import {httpGet} from "../../utils/Utils";
import {MultiChain} from "../../swaps/Swapper";

export type CoinPaprikaResponse<Currency extends string> = {
    quotes: {
        [curr in Currency]: {
            price: number
        }
    }
};

export class CoinPaprikaPriceProvider<T extends MultiChain> extends HttpPriceProvider<T> {

    constructor(coinsMap: CtorCoinTypes<T>, url: string = "https://api.coinpaprika.com/v1", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    async fetchPrice(token: CoinType, abortSignal?: AbortSignal) {
        const response = await httpGet<CoinPaprikaResponse<"BTC">>(
            this.url+"/tickers/"+token.coinId+"?quotes=BTC",
            this.httpRequestTimeout,
            abortSignal
        );

        return new BN(response.quotes.BTC.price*100000000000000);
    }

    protected async fetchUsdPrice(abortSignal?: AbortSignal): Promise<number> {
        const response = await httpGet<CoinPaprikaResponse<"USD">>(
            this.url+"/tickers/btc-bitcoin?quotes=USD",
            this.httpRequestTimeout,
            abortSignal
        );

        return response.quotes.USD.price/100000000;
    }

}