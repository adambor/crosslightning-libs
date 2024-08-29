import * as BN from "bn.js";
import {getWithTimeout} from "../../utils/RetryUtils";
import {CoinType, CoinTypes, IPriceProvider} from "../abstract/IPriceProvider";
import {HttpPriceProvider} from "./abstract/HttpPriceProvider";

export type CoinGeckoResponse = {
    [coinId: string]: {sats: number}
};

export class CoinGeckoPriceProvider extends HttpPriceProvider {

    constructor(coinsMap: CoinTypes, url: string = "https://api.coingecko.com/api/v3", httpRequestTimeout?: number) {
        super(coinsMap, url, httpRequestTimeout);
    }

    protected async fetchPrice(token: CoinType, abortSignal?: AbortSignal): Promise<BN> {
        let response = await getWithTimeout<CoinGeckoResponse>(
            this.url+"/simple/price?ids="+token.coinId+"&vs_currencies=sats&precision=6",
            this.httpRequestTimeout,
            abortSignal
        );

        return new BN(response[token.coinId].sats*1000000);
    }

}
