import {SwapEvent} from "./SwapEvent";
import {SwapData} from "../../swaps/SwapData";
import * as BN from "bn.js";

export class ClaimEvent<T extends SwapData> extends SwapEvent<T> {

    secret: string;

    constructor(paymentHash: string, sequence: BN, secret: string) {
        super(paymentHash, sequence);
        this.secret = secret;
    }

}
