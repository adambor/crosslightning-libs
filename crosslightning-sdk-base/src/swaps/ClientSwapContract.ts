import * as BN from "bn.js";
import {
    TokenAddress
} from "crosslightning-base";

export type AmountData = {
    amount: BN,
    token: TokenAddress,
    exactIn?: boolean
}
