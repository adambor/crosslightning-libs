import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";


export interface IPriceProvider {

    /**
     * Returns coin price in mSat
     *
     * @param pair
     * @param invert
     */
    getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN>;

}