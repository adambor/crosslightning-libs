import {SwapEvent} from "./SwapEvent";
import {SwapData} from "../../swaps/SwapData";
import * as BN from "bn.js";
import {ChainSwapType} from "../../swaps/ChainSwapType";

export class InitializeEvent<T extends SwapData> extends SwapEvent<T> {

    txoHash: string;
    swapType: ChainSwapType;
    swapData: () => Promise<T>;

    constructor(paymentHash: string, sequence: BN, txoHash: string, swapType: ChainSwapType, swapData: () => Promise<T>) {
        super(paymentHash, sequence);
        this.txoHash = txoHash;
        this.swapType = swapType;
        this.swapData = swapData;
    }

}
