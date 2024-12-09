import {Request, Response} from "express";
import {ServerParamEncoder} from "./paramcoders/server/ServerParamEncoder";
import * as BN from "bn.js";

export type DefinedRuntimeError = {
    code: number;
    msg?: string;
    _httpStatus?: number;
    data?: any;
};

export function isDefinedRuntimeError(obj: any): obj is DefinedRuntimeError {
    if(obj.code!=null && typeof(obj.code)==="number") {
        if(obj.msg!=null && typeof(obj.msg)!=="string") return false;
        if(obj._httpStatus!=null && typeof(obj._httpStatus)!=="number") return false;
        return true;
    }
    return false;
}

export function expressHandlerWrapper(func: (
    req: Request,
    res: Response
) => Promise<void>) : ((
    req: Request,
    res: Response & {responseStream: ServerParamEncoder}
) => void) {
    return (
        req: Request,
        res: Response & {responseStream: ServerParamEncoder}
    ) => {
        (async () => {
            try {
                await func(req, res);
            } catch (e) {
                console.error(e);
                let statusCode = 500;
                const obj: {code: number, msg: string, data?: any} = {
                    code: 0,
                    msg: "Internal server error"
                };
                if(isDefinedRuntimeError(e)) {
                    obj.msg = e.msg;
                    obj.code = e.code;
                    obj.data = e.data;
                    statusCode = 400;
                    if(e._httpStatus!=null) statusCode = e._httpStatus;
                }
                if(res.responseStream!=null) {
                    if(res.responseStream.getAbortSignal().aborted) return;
                    res.responseStream.writeParamsAndEnd(obj).catch(e => null);
                } else {
                    res.status(statusCode).json(obj);
                }
            }
        })();
    }
}

export function getLogger(prefix: string) {
    return {
        debug: (msg, ...args) => console.debug(prefix+msg, ...args),
        info: (msg, ...args) => console.info(prefix+msg, ...args),
        warn: (msg, ...args) => console.warn(prefix+msg, ...args),
        error: (msg, ...args) => console.error(prefix+msg, ...args)
    };
}

export const HEX_REGEX = /[0-9a-fA-F]+/;

export function shuffle(array: any[]) {
    let currentIndex = array.length;

    // While there remain elements to shuffle...
    while (currentIndex != 0) {

        // Pick a remaining element...
        let randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
    }
}

export function serializeBN(bn: BN | null): string | null {
    return bn==null ? null : bn.toString(10);
}

export function deserializeBN(str: string | null): BN | null {
    return str==null ? null : new BN(str);
}

/**
 * Handles & throws LND error if the error is:
 *  - network error
 *  - server side (LND) internal error
 *  - malformed input data error
 *
 * @param e
 */
export function handleLndError(e: any) {
    if(!Array.isArray(e)) throw e; //Throw errors that are not originating from the SDK
    if(typeof(e[0])!=="number") throw e; //Throw errors that don't have proper format
    if(e[0]>=500 && e[0]<600) throw e; //Throw server errors 5xx
    if(e[0]===400) throw e; //Throw malformed request data errors
}
