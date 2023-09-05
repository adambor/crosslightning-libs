import * as BN from "bn.js";
import {RequestError} from "./RequestError";

export class OutOfBoundsError extends RequestError {

    min: BN;
    max: BN;

    constructor(msg: string, httpCode: number, min: BN, max: BN) {
        super(msg, httpCode);
        this.max = max;
        this.min = min;
        Object.setPrototypeOf(this, OutOfBoundsError.prototype);
    }

}
