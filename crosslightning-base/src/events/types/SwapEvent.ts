import {SwapData} from "../../swaps/SwapData";
import * as BN from "bn.js";


export class SwapEvent<T extends SwapData> {

    meta?: {
        blockTime: number,
        txId: string
    };
    paymentHash: string;
    sequence: BN;

    constructor(paymentHash: string, sequence: BN) {
        this.paymentHash = paymentHash;
        this.sequence = sequence;
    }

}
