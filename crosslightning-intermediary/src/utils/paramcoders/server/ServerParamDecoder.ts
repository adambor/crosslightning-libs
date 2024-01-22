import {Request, Response} from "express";
import {RequestSchema, verifySchema} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";


export const serverParamDecoder = (timeoutMillis: number) => (req: Request, res: Response, next: () => void) => {

    let timeout;

    if(req.headers['content-type']!=="application/x-multiple-json") {

        const dataBuffers: Buffer[] = [];
        req.on("data", (data: Buffer) => dataBuffers.push(data));
        req.on("end", () => {
            console.log("Request end, buffers: ", dataBuffers);
            const body = JSON.parse(Buffer.concat(dataBuffers).toString());
            (req as any).paramReader = {
                getParams: <T extends RequestSchema>(schema: T) => {
                    return Promise.resolve(verifySchema(body, schema));
                }
            };
            clearTimeout(timeout);
            next();
        });
        req.on("error", (e) => {
            console.error(e);
        });

        timeout = setTimeout(() => {
            req.destroy(new Error("Timed out"));
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
        req.destroy(new Error("Timed out"));
    }, timeoutMillis);

    (req as any).paramReader = decoder;

    next();
    return;

}
