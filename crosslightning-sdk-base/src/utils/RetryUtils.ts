import fetch from "cross-fetch";
import {NetworkError} from "../errors/NetworkError";
import {streamingFetch} from "./paramcoders/client/StreamingFetch";
import {IParamReader} from "./paramcoders/IParamReader";
import {ParamEncoder} from "./paramcoders/ParamEncoder";


export async function tryWithRetries<T>(func: () => Promise<T>, retryPolicy?: {
    maxRetries?: number, delay?: number, exponential?: boolean
}, errorAllowed?: (e: any) => boolean, abortSignal?: AbortSignal): Promise<T> {

    retryPolicy = retryPolicy || {};
    retryPolicy.maxRetries = retryPolicy.maxRetries || 5;
    retryPolicy.delay = retryPolicy.delay || 500;
    retryPolicy.exponential =  retryPolicy.exponential==null ? true : retryPolicy.exponential;

    let err = null;

    for(let i=0;i<retryPolicy.maxRetries;i++) {
        try {
            const resp: T = await func();
            return resp;
        } catch (e) {
            if(errorAllowed!=null && errorAllowed(e)) throw e;
            err = e;
            console.error("tryWithRetries: "+i, e);
        }
        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");
        if(i!==retryPolicy.maxRetries-1) {
            await new Promise(resolve => setTimeout(resolve, retryPolicy.exponential ? retryPolicy.delay*Math.pow(2, i) : retryPolicy.delay));
        }
    }

    throw err;

}

export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit & {timeout?: number}): Promise<Response> {
    if(init==null) init = {};
    if(init.timeout==null) return fetch(input, init);

    let timedOut = false;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort("Timed out")
    }, init.timeout);
    let originalSignal: AbortSignal;
    if(init.signal!=null) {
        originalSignal = init.signal;
        init.signal.addEventListener("abort", (reason) => {
            clearTimeout(timeoutHandle);
            abortController.abort(reason);
        });
    }
    init.signal = abortController.signal;
    return fetch(input, init).catch(e => {
        if(e.name==="AbortError" && (originalSignal==null || !originalSignal.aborted) && timedOut) {
            throw new NetworkError("Network request timed out")
        } else {
            throw e;
        }
    });
};

export function fetchStreamingWithTimeout(input: RequestInfo | URL, init: RequestInit & {timeout?: number}): {
    response: Promise<Response & { inputStream: IParamReader }>,
    outputStream?: ParamEncoder
} {
    if(init==null) init = {};
    if(init.timeout==null) return streamingFetch(input, init);

    let timedOut = false;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort("Timed out")
    }, init.timeout);
    let originalSignal: AbortSignal;
    if(init.signal!=null) {
        originalSignal = init.signal;
        init.signal.addEventListener("abort", (reason) => {
            clearTimeout(timeoutHandle);
            abortController.abort(reason);
        });
    }
    init.signal = abortController.signal;
    const resp = streamingFetch(input, init);
    resp.response = resp.response.catch(e => {
        if(e.name==="AbortError" && (originalSignal==null || !originalSignal.aborted) && timedOut) {
            throw new NetworkError("Network request timed out")
        } else {
            throw e;
        }
    });
    return resp;
};

export function timeoutSignal(timeout: number, abortSignal?: AbortSignal) {
    if(timeout==null) return abortSignal;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort("Timed out"), timeout)
    if(abortSignal!=null) {
        abortSignal.addEventListener("abort", (reason) => {
            clearTimeout(timeoutHandle);
            abortController.abort(reason);
        });
    }
    return abortController.signal;
}
