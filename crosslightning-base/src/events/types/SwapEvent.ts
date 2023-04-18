import {SwapData} from "../../swaps/SwapData";


export class SwapEvent<T extends SwapData> {

    paymentHash: string;

    constructor(paymentHash: string) {
        this.paymentHash = paymentHash;
    }

}
