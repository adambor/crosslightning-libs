import {SwapEvent} from "./SwapEvent";
import {SwapData} from "../../swaps/SwapData";

export class RefundEvent<T extends SwapData> extends SwapEvent<T> {

    constructor(paymentHash: string) {
        super(paymentHash);
    }

}
