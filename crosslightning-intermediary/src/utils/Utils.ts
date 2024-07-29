import {ParamsDictionary, Request, Response} from "express";
import * as QueryString from "qs";
import {ServerParamEncoder} from "./paramcoders/server/ServerParamEncoder";

export type DefinedRuntimeError = {
    code: number;
    msg?: string;
};

export function isDefinedRuntimeError(obj: any): obj is DefinedRuntimeError {
    if(obj.code!=null && typeof(obj.code)==="number") {
        if(obj.msg!=null && typeof(obj.msg)!=="string") return false;
        return true;
    }
    return false;
}

export function expressHandlerWrapper(func: (
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number>
) => Promise<void>) : ((
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number> & {responseStream: ServerParamEncoder}
) => void) {
    return (
        req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
        res: Response<any, Record<string, any>, number> & {responseStream: ServerParamEncoder}
    ) => {
        (async () => {
            try {
                await func(req, res);
            } catch (e) {
                console.error(e);
                const obj = {
                    code: 0,
                    msg: "Internal server error"
                };
                if(isDefinedRuntimeError(e)) {
                    obj.msg = e.msg;
                    obj.code = e.code;
                }
                if(res.responseStream!=null) {
                    if(res.responseStream.getAbortSignal().aborted) return;
                    res.responseStream.writeParamsAndEnd(obj).catch(e => null);
                } else {
                    res.status(500).json(obj);
                }
            }
        })();
    }
}

export const HEX_REGEX = /[0-9a-fA-F]+/;