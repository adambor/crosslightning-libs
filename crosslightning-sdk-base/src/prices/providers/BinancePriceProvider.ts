import {CtorCoinTypes} from "../abstract/IPriceProvider";
import {ExchangePriceProvider} from "./abstract/ExchangePriceProvider";
import {httpGet} from "../../utils/Utils";
import {MultiChain} from "../../swaps/Swapper";

export type BinanceResponse = {
    symbol: string;
    price: string;
};

export class BinancePriceProvider<T extends MultiChain> extends ExchangePriceProvider<T> {

    constructor(coinsMap: CtorCoinTypes<T>, url: string = "https://api.binance.com/api/v3", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    async fetchPair(pair: string, abortSignal?: AbortSignal) {
        const response = await httpGet<BinanceResponse>(
            this.url+"/ticker/price?symbol="+pair,
            this.httpRequestTimeout,
            abortSignal
        );

        return parseFloat(response.price);
    }

}
