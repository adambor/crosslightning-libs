import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";

export interface ISwapPrice {

    preFetchPrice?(token: TokenAddress): Promise<BN>;

    /**
     * Returns amount of satoshis that are equivalent to {fromAmount} of {fromToken}
     *
     * @param fromAmount        Amount of the token
     * @param fromToken         Token
     * @param roundUp           Whether result should be rounded up
     */
    getToBtcSwapAmount(fromAmount:BN, fromToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN>;

    /**
     * Returns amount of {toToken} that are equivalent to {fromAmount} satoshis
     *
     * @param fromAmount        Amount of satoshis
     * @param toToken           Token
     * @param roundUp           Whether result be rounded up
     */
    getFromBtcSwapAmount(fromAmount:BN, toToken: TokenAddress, roundUp?: boolean, preFetchedPrice?: BN): Promise<BN>;

}
