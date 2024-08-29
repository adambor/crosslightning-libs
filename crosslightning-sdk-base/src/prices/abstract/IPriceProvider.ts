import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";

export type CoinType = {
    coinId: string;
    decimals: number;
};

export type CoinTypes = {
    [address: string]: CoinType
}

export abstract class IPriceProvider {

    coinsMap: CoinTypes = {};

    protected constructor(coinsMap: CoinTypes) {
        this.coinsMap = coinsMap;
    }

    protected abstract fetchPrice(token: CoinType, abortSignal?: AbortSignal): Promise<BN>;

    /**
     * Returns coin price in uSat (microSat)
     *
     * @param token
     * @param abortSignal
     */
    getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        let tokenAddress: string = token.toString();

        const coin = this.coinsMap[tokenAddress];
        if(coin==null) throw new Error("Token not found");

        if(coin.coinId.startsWith("$fixed-")) {
            const amt: number = parseFloat(coin.coinId.substring(7));
            return Promise.resolve(new BN(Math.floor(amt*1000000)));
        }

        return this.fetchPrice(coin, abortSignal);
    }

    getDecimals(token: TokenAddress): number {
        const coin = this.coinsMap[token.toString()];

        if(coin==null) throw new Error("Token not found");

        return coin.coinId==="$ignore" ? -1 : coin.decimals;
    }

}