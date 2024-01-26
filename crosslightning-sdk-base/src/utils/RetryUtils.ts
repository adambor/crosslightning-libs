import fetch from "cross-fetch";
import {NetworkError} from "../errors/NetworkError";

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
        if(abortSignal!=null && abortSignal.aborted) throw (abortSignal.reason || new Error("Aborted"));
        if(i!==retryPolicy.maxRetries-1) {
            await new Promise<void>((resolve, reject) => {
                let timeout;
                let abortHandler;

                timeout = setTimeout(() => {
                    if(abortSignal!=null) abortSignal.removeEventListener("abort", abortHandler);
                    resolve()
                }, retryPolicy.exponential ? retryPolicy.delay*Math.pow(2, i) : retryPolicy.delay);
                abortHandler = () => {
                    clearTimeout(timeout);
                    reject(abortSignal.reason);
                };

                if(abortSignal!=null) abortSignal.addEventListener("abort", abortHandler);
            });
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
        abortController.abort(new Error("Network request timed out"))
    }, init.timeout);
    let originalSignal: AbortSignal;
    if(init.signal!=null) {
        originalSignal = init.signal;
        originalSignal.addEventListener("abort", () => {
            clearTimeout(timeoutHandle);
            abortController.abort(originalSignal.reason);
        });
    }
    init.signal = abortController.signal;
    return fetch(input, init).catch(e => {
        if(e.name==="AbortError") {
            throw init.signal.reason;
        } else {
            throw e;
        }
    });
};

export function timeoutSignal(timeout: number, abortSignal?: AbortSignal) {
    if(timeout==null) return abortSignal;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(new Error("Timed out")), timeout);
    if(abortSignal!=null) {
        abortSignal.addEventListener("abort", () => {
            clearTimeout(timeoutHandle);
            abortController.abort(abortSignal.reason);
        });
    }
    return abortController.signal;
}
