import * as BN from "bn.js";
import {RequestError} from "./RequestError";

/**
 * An error indicating out of bounds (amount too high or too low) on swap initialization
 */
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
