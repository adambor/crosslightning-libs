import {CoinTypes, IPriceProvider} from "../../abstract/IPriceProvider";

export abstract class HttpPriceProvider extends IPriceProvider {

    url: string;
    httpRequestTimeout?: number;

    protected constructor(coinsMap: CoinTypes, url: string, httpRequestTimeout?: number) {
        super(coinsMap);
        this.url = url;
        this.httpRequestTimeout = httpRequestTimeout;
    }

}