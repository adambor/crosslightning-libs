import {ParamEncoder} from "../ParamEncoder";
import {RequestSchema, RequestSchemaResultPromise, verifyField} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";

export type RequestBody = {
    [key: string]: Promise<any> | any
}

//https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests#feature_detection
const supportsRequestStreams: boolean = (() => {
    let duplexAccessed = false;

    const hasContentType = new Request('', {
        body: new ReadableStream(),
        method: 'POST',
        get duplex() {
            duplexAccessed = true;
            return 'half';
        },
    } as any).headers.has('Content-Type');

    return duplexAccessed && !hasContentType;
})();


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
export function streamingFetchWithTimeoutPromise<T extends RequestSchema>(url: string, body: RequestBody, schema: T, timeout?: number, signal?: AbortSignal): Promise<{
    response: Response,
    responseBody?: RequestSchemaResultPromise<T>
}> {
    if(timeout==null) return streamingFetchPromise<T>(url, body, schema, signal);

    let timedOut = false;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("Network request timed out"))
    }, timeout);
    let originalSignal: AbortSignal;
    if(signal!=null) {
        originalSignal = signal;
        originalSignal.addEventListener("abort", () => {
            clearTimeout(timeoutHandle);
            abortController.abort(originalSignal.reason);
        });
    }

    signal = abortController.signal;

    return streamingFetchPromise<T>(url, body, schema, signal);
}

export async function streamingFetchPromise<T extends RequestSchema>(url: string, body: RequestBody, schema: T, signal?: AbortSignal): Promise<{
    response: Response,
    responseBody?: RequestSchemaResultPromise<T>
}> {

    const init: RequestInit = {
        method: "POST"
    };

    if(!supportsRequestStreams) {

        const immediateValues: any = {};

        const promises: Promise<any>[] = [];

        for(let key in body) {
            if(body[key] instanceof Promise) {
                promises.push(body[key].then((val) => {
                    immediateValues[key] = val;
                }));
            } else {
                immediateValues[key] = body[key];
            }
        }

        await Promise.all(promises);

        if(signal!=null) signal.throwIfAborted();

        init.body = JSON.stringify(immediateValues);
        if(init.headers==null) init.headers = {};
        init.headers['content-type'] = "application/json";

    } else {

        let hasPromiseInBody = false;
        const immediateValues: any = {};

        let stream = new TransformStream();
        let writeStream = stream.writable.getWriter();
        const outputStream = new ParamEncoder(writeStream.write.bind(writeStream), writeStream.close.bind(writeStream));

        const promises: Promise<any>[] = [];

        for(let key in body) {
            if(body[key] instanceof Promise) {
                promises.push(body[key].then((val) => {
                    return outputStream.writeParams({
                        [key]: val
                    });
                }));
                hasPromiseInBody = true;
            } else {
                immediateValues[key] = body[key];
            }
        }

        if(hasPromiseInBody) {
            init.body = stream.readable;
            if(init.headers==null) init.headers = {};
            init.headers['content-type'] = "application/x-multiple-json";
            (init as any).duplex = "half";

            promises.push(outputStream.writeParams(immediateValues));

            const abortController = new AbortController();
            if(signal!=null) {
                signal.addEventListener("abort", () => abortController.abort(signal.reason));
            }
            Promise.all(promises).then(() => outputStream.end()).catch(e => {
                abortController.abort(e);
            });
            signal = abortController.signal;

            signal.addEventListener("abort", () => {
                if(!writeStream.closed) writeStream.close();
            });
        } else {
            init.body = JSON.stringify(immediateValues);
            if(init.headers==null) init.headers = {};
            init.headers['content-type'] = "application/json";
        }

    }

    if(signal!=null) init.signal = signal;
    if(init.headers==null) init.headers = {};
    init.headers['accept'] = "application/x-multiple-json";

    const resp = await fetch(url, init).catch(e => {
        if(init.signal!=null && e.name==="AbortError") {
            throw init.signal.reason;
        } else {
            throw e;
        }
    });

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

        try {
            //Read from stream
            const reader = resp.body.getReader();

            if(init.signal!=null) init.signal.addEventListener("abort", () => {
                if(!reader.closed) reader.cancel(signal.reason);
            });

            readResponse(reader, inputStream);
        } catch (e) {
            //Read in one piece
            resp.arrayBuffer().then(respBuffer => {
                if(init.signal!=null && init.signal.aborted) {
                    inputStream.onError(init.signal.reason);
                    return;
                }
                inputStream.onData(Buffer.from(respBuffer));
                inputStream.onEnd();
            }).catch(e => {
                inputStream.onError(e);
            });
        }

    }

    return {
        response: resp,
        responseBody
    };
}