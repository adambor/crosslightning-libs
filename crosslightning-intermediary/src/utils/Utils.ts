import {ParamsDictionary, Request, Response} from "express";
import * as QueryString from "qs";
import {ServerParamEncoder} from "./paramcoders/server/ServerParamEncoder";

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
        func(req, res).catch(e => {
            console.error(e);
            if(res.responseStream!=null) {
                if(res.responseStream.getAbortSignal().aborted) return;
                res.responseStream.writeParamsAndEnd({
                    code: 0,
                    msg: "Internal server error"
                }).catch(e => null);
            } else {
                res.status(500).json({
                    code: 0,
                    msg: "Internal server error"
                });
            }
        });
    }
}

export const HEX_REGEX = /[0-9a-fA-F]+/;