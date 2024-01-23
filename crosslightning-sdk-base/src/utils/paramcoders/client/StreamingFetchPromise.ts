import {ParamEncoder} from "../ParamEncoder";
import {IParamReader} from "../IParamReader";
import {RequestSchema, RequestSchemaResultPromise, verifyField, verifySchema} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";

type RequestBody = {
    [key: string]: Promise<any> | any
}

async function readResponse(reader: ReadableStreamDefaultReader, inputStream: ParamDecoder) {
    while(true) {
        const readResp = await reader.read().catch(e => {
            console.error(e);
            return null;
        });
        if(readResp==null || readResp.done) {
            inputStream.onEnd();
            break;
        }
        inputStream.onData(Buffer.from(readResp.value));
    }
}

export async function streamingFetchPromise<T extends RequestSchema>(url: URL, body: RequestBody, schema: T, signal: AbortSignal): Promise<{
    response: Response,
    responseBody?: RequestSchemaResultPromise<T>
}> {

    let hasPromiseInBody = false;
    const immediateValues: any = {};

    let stream = new TransformStream();
    let writeStream = stream.writable.getWriter();
    const outputStream = new ParamEncoder(writeStream.write.bind(writeStream), writeStream.close.bind(writeStream));

    if(signal!=null) signal.addEventListener("abort", () => {
        if(!writeStream.closed) writeStream.close();
    });

    const promises: Promise<any>[] = [];

    for(let key in body) {
        if(body[key] instanceof Promise) {
            let noWrite = true;
            let resolvedValue: any;
            promises.push(immediateValues[key].then((val) => {
                if(noWrite) {
                    resolvedValue = val;
                } else {
                    return outputStream.writeParams({
                        [key]: val
                    });
                }
            }));
            noWrite = false;
            if(resolvedValue!==undefined) {
                immediateValues[key] = resolvedValue;
            } else {
                hasPromiseInBody = true;
            }
        } else {
            immediateValues[key] = body[key];
        }
    }

    Promise.all(promises).then(() => outputStream.end());

    const init: RequestInit = {};
    if(hasPromiseInBody) {
        init.body = stream.readable;
        if(init.headers==null) init.headers = {};
        init.headers['content-type'] = "application/x-multiple-json";
        (init as any).duplex = "half";
    } else {
        init.body = JSON.stringify(immediateValues);
        if(init.headers==null) init.headers = {};
        init.headers['content-type'] = "application/json";
    }

    if(signal!=null) init.signal = signal;

    const resp = await fetch(url, init);

    if(resp.status!==200) {
        return {
            response: resp
        };
    }

    const responseBody: any = {};

    if(resp.headers.get("content-type")!=="application/x-multiple-json") {
        const respBody = await resp.json();

        for(let key in schema) {
            const value = respBody[key];

            if(value===undefined) {
                responseBody[key] = Promise.reject(new Error("EOF before field seen!"));
            } else {
                const result = verifyField(schema[key], value);
                if(value===undefined) {
                    responseBody[key] = Promise.reject(new Error("Invalid field value"));
                } else {
                    responseBody[key] = Promise.resolve(result);
                }
            }
        }
    } else {
        const inputStream = new ParamDecoder();
        const reader = resp.body.getReader();

        if(init.signal!=null) init.signal.addEventListener("abort", (reason) => {
            if(!reader.closed) reader.cancel(reason);
        });

        for(let key in schema) {
            responseBody[key] = inputStream.getParam(key).then(value => {
                const result = verifyField(schema[key], value);
                if(value===undefined) {
                    return Promise.reject(new Error("Invalid field value"));
                } else {
                    return result;
                }
            });
        }

        readResponse(reader, inputStream);
    }

    return {
        response: resp,
        responseBody
    };
}