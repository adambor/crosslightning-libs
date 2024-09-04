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

    /**
     * Fetches the price for a given token against BTC
     *
     * @param token
     * @param abortSignal
     * @protected
     * @returns Price per token in uSats (micro sats)
     */
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

    /**
     * Returns the decimal places of the specified token, or -1 if token should be ignored, returns null if
     *  token is not found
     *
     * @param token
     * @protected
     */
    getDecimals(token: TokenAddress): number {
        const coin = this.coinsMap[token.toString()];

        if(coin==null) throw new Error("Token not found");

        return coin.coinId==="$ignore" ? -1 : coin.decimals;
    }

}