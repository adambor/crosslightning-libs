import {ParamsDictionary, Request, Response} from "express";
import * as QueryString from "qs";

export function expressHandlerWrapper(func: (
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number>
) => Promise<void>) : ((
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number>
) => void) {
    return (
        req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
        res: Response<any, Record<string, any>, number>
    ) => {
        func(req, res).catch(e => {
            console.error(e);
            res.status(500).json({
                msg: "Internal server error"
            });
        });
    }
}

export const HEX_REGEX = /[0-9a-fA-F]+/;