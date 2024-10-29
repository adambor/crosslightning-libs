import {Request, Response} from "express";
import {RequestSchema, verifySchema} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";
import {ServerParamEncoder} from "./ServerParamEncoder";
import {IParamReader} from "../IParamReader";

export class RequestTimeoutError extends Error {

    constructor() {
        super("Request timed out");
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, RequestTimeoutError.prototype);
    }

}

export class RequestParsingError extends Error {

    constructor() {
        super("Request cannot be parsed");
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, RequestParsingError.prototype);
    }

}

export const serverParamDecoder = (timeoutMillis: number) => (req: Request, res: Response, next: () => void) => {

    let timeout;

    (res as any).responseStream = new ServerParamEncoder(res, 200, req);

    if(req.headers['content-type']!=="application/x-multiple-json") {

        const dataBuffers: Buffer[] = [];
        req.on("data", (data: Buffer) => {
            dataBuffers.push(data)
        });
        req.on("end", () => {
            try {
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
                next();
            } catch (e) {
                console.error("ServerParamDecoder: error reading legacy (non-streaming) http request", e);
                req.destroy(new RequestParsingError());
                res.destroy(new RequestParsingError());
            }
            clearTimeout(timeout);
        });
        req.on("error", (e) => {
            console.error("ServerParamDecoder: error reading legacy (non-streaming) http request",e);
        });

        timeout = setTimeout(() => {
            req.destroy(new RequestTimeoutError());
            res.destroy(new RequestTimeoutError());
        }, timeoutMillis);

        return;

    }

    const decoder = new ParamDecoder();
    req.on("data", (data: Buffer) => {
        try {
            decoder.onData(data);
        } catch (e) {
            console.error("ServerParamDecoder: error reading streaming http request: on(\"data\")", e);
            req.destroy(new RequestParsingError());
            res.destroy(new RequestParsingError());
        }
    });
    req.on("end", () => {
        try {
            decoder.onEnd();
        } catch (e) {
            console.error("ServerParamDecoder: error reading streaming http request: on(\"end\")", e);
            req.destroy(new RequestParsingError());
            res.destroy(new RequestParsingError());
        }
        clearTimeout(timeout);
    });
    req.on("error", (e) => {
        try {
            decoder.onError(e);
        } catch(e) {
            console.error("ServerParamDecoder: error reading streaming http request: on(\"error\")", e);
        }
    });

    timeout = setTimeout(() => {
        try {
            decoder.onEnd();
        } catch(e) {
            console.error("ServerParamDecoder: error reading streaming http request: timeout", e);
        }
        req.destroy(new RequestTimeoutError());
        res.destroy(new RequestTimeoutError());
    }, timeoutMillis);

    (req as any).paramReader = decoder;

    next();
    return;

}
