import {SwapEvent} from "./SwapEvent";
import {SwapData} from "../../swaps/SwapData";
import * as BN from "bn.js";

export class RefundEvent<T extends SwapData> extends SwapEvent<T> {

    constructor(paymentHash: string, sequence: BN) {
        super(paymentHash, sequence);
    }

}
