import * as BN from "bn.js";
import {CoinType, CtorCoinTypes} from "../abstract/IPriceProvider";
import {HttpPriceProvider} from "./abstract/HttpPriceProvider";
import {httpGet} from "../../utils/Utils";
import {MultiChain} from "../../swaps/Swapper";

export type CoinGeckoResponse<Currency extends string> = {
    [coinId: string]: {[c in Currency]: number}
};

export class CoinGeckoPriceProvider<T extends MultiChain> extends HttpPriceProvider<T> {

    constructor(coinsMap: CtorCoinTypes<T>, url: string = "https://api.coingecko.com/api/v3", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    protected async fetchPrice(token: CoinType, abortSignal?: AbortSignal): Promise<BN> {
        let response = await httpGet<CoinGeckoResponse<"sats">>(
            this.url+"/simple/price?ids="+token.coinId+"&vs_currencies=sats&precision=6",
            this.httpRequestTimeout,
            abortSignal
        );

        return new BN(response[token.coinId].sats*1000000);
    }

    protected async fetchUsdPrice(abortSignal?: AbortSignal): Promise<number> {
        let response = await httpGet<CoinGeckoResponse<"usd">>(
            this.url+"/simple/price?ids=bitcoin&vs_currencies=usd&precision=9",
            this.httpRequestTimeout,
            abortSignal
        );

        return response["bitcoin"].usd/100000000;
    }

}
