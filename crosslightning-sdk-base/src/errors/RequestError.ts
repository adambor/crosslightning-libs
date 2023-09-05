import {OutOfBoundsError} from "./OutOfBoundsError";
import * as BN from "bn.js";

export class RequestError extends Error {

    httpCode: number;

    constructor(msg: string, httpCode: number) {
        try {
            const parsed = JSON.parse(msg);
            if(parsed.msg!=null) msg = parsed.msg;
        } catch (e) {}
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, RequestError.prototype);
        this.httpCode = httpCode;
    }

    static parse(msg: string, httpCode: number): RequestError {
        try {
            const parsed = JSON.parse(msg);
            msg = parsed.msg;
            if(parsed.code===20003 || parsed.code===20004) {
                return new OutOfBoundsError(parsed.msg, httpCode, new BN(parsed.data.min), new BN(parsed.data.max));
            }
        } catch (e) {}
        return new RequestError(msg, httpCode);
    }

}