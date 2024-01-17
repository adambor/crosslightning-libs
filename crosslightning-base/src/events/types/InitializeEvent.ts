import {SwapEvent} from "./SwapEvent";
import {SwapData} from "../../swaps/SwapData";
import * as BN from "bn.js";

export class InitializeEvent<T extends SwapData> extends SwapEvent<T> {

    txoHash: string;
    signatureNonce: number;
    swapData: T;

    constructor(paymentHash: string, sequence: BN, txoHash: string, signatureNonce: number, swapData: T) {
        super(paymentHash, sequence);
        this.txoHash = txoHash;
        this.signatureNonce = signatureNonce;
        this.swapData = swapData;
    }

}
