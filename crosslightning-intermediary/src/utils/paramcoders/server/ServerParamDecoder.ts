import {Request, Response} from "express";
import {RequestSchema, verifySchema} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";
import {ServerParamEncoder} from "./ServerParamEncoder";
import {ServerResponse} from "http";
import {IParamReader} from "../IParamReader";

export class RequestTimeoutError extends Error {

    constructor() {
        super("Request timed out");
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, RequestTimeoutError.prototype);
    }

}

export const serverParamDecoder = (timeoutMillis: number) => (req: Request, res: Response, next: () => void) => {

    let timeout;

    (res as any).responseStream = new ServerParamEncoder(res, 200, req);

    if(req.headers['content-type']!=="application/x-multiple-json") {

        const dataBuffers: Buffer[] = [];
        req.on("data", (data: Buffer) => {
            console.log("Normal data read: ", data);
            dataBuffers.push(data)
        });
        req.on("end", () => {
            console.log("Request end, buffers: ", dataBuffers);
            const body = JSON.parse(Buffer.concat(dataBuffers).toString());
            const paramReader: IParamReader = {
                getParams: <T extends RequestSchema>(schema: T) => {
                    return Promise.resolve(verifySchema(body, schema));
                },
                getExistingParamsOrNull: <T extends RequestSchema>(schema: T) => {
                    return verifySchema(body, schema);
                }
            };
            (req as any).paramReader = paramReader;
            clearTimeout(timeout);
            next();
        });
        req.on("error", (e) => {
            console.error(e);
        });

        timeout = setTimeout(() => {
            req.destroy(new RequestTimeoutError());
            res.destroy(new RequestTimeoutError());
        }, timeoutMillis);

        return;

    }

    const decoder = new ParamDecoder();
    req.on("data", decoder.onData.bind(decoder));
    req.on("end", () => {
        console.log("Request end!");
        decoder.onEnd();
        clearTimeout(timeout);
    });
    req.on("error", (e) => {
        decoder.onError(e);
    });

    timeout = setTimeout(() => {
        decoder.onEnd();
        req.destroy(new RequestTimeoutError());
        res.destroy(new RequestTimeoutError());
    }, timeoutMillis);

    (req as any).paramReader = decoder;

    next();
    return;

}
