import {HttpPriceProvider} from "./HttpPriceProvider";
import {CoinType} from "../../abstract/IPriceProvider";
import * as BN from "bn.js";
import {MultiChain} from "../../../swaps/Swapper";

export abstract class ExchangePriceProvider<T extends MultiChain> extends HttpPriceProvider<T> {

    /**
     * Fetches the price on the specific exchange pair
     *
     * @param pair
     * @param abortSignal
     * @protected
     */
    protected abstract fetchPair(pair: string, abortSignal?: AbortSignal): Promise<number>;

    protected async fetchPrice(token: CoinType, abortSignal?: AbortSignal): Promise<BN> {
        const pairs: string[] = token.coinId.split(";");
        const prices: number[] = await Promise.all(pairs.map(pair => {
            let invert = pair.startsWith("!");
            if(invert) pair = pair.substring(1);
            return this.fetchPair(pair, abortSignal).then(value => invert ? 1/value : value);
        }));

        const price = prices.reduce((previousValue, currentValue) => previousValue * currentValue, 1);

        return new BN(Math.floor(price*100000000000000));
    }

}