import {RequestError} from "../errors/RequestError";

/**
 * Returns a promise that resolves when any of the passed promises resolves, and rejects if all the underlying
 *  promises fail with an array of errors returned by the respective promises
 *
 * @param promises
 */
export function promiseAny<T>(promises: Promise<T>[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let numRejected = 0;
        const rejectReasons = Array(promises.length);

        promises.forEach((promise, index) => {
            promise.then((val) => {
                if(resolve!=null) resolve(val);
                resolve = null;
            }).catch(err => {
                rejectReasons[index] = err;
                numRejected++;
                if(numRejected===promises.length) {
                    reject(rejectReasons);
                }
            })
        })
    });
}

/**
 * Maps a JS object to another JS object based on the translation function, the translation function is called for every
 *  property (value/key) of the old object and returns the new value of for this property
 *
 * @param obj
 * @param translator
 */
export function objectMap<InputType, OutputType>(
    obj: {[key: string]: InputType},
    translator: (value: InputType, key: string) => OutputType
): {[key: string]: OutputType} {
    const resp: {[key: string]: OutputType} = {};
    for(let key in obj) {
        resp[key] = translator(obj[key], key);
    }
    return resp;
}

/**
 * Creates a new abort controller that will abort if the passed abort signal aborts
 *
 * @param abortSignal
 */
export function extendAbortController(abortSignal?: AbortSignal) {
    const _abortController = new AbortController();
    if(abortSignal!=null) abortSignal.onabort = () => _abortController.abort(abortSignal.reason);
    return _abortController;
}

/**
 * Runs the passed function multiple times if it fails
 *
 * @param func A callback for executing the action
 * @param retryPolicy Retry policy
 * @param retryPolicy.maxRetries How many retries to attempt in total
 * @param retryPolicy.delay How long should the delay be
 * @param retryPolicy.exponential Whether to use exponentially increasing delays
 * @param errorAllowed A callback for determining whether a given error is allowed, and we should therefore not retry
 * @param abortSignal
 * @returns Result of the action executing callback
 */
export async function tryWithRetries<T>(func: () => Promise<T>, retryPolicy?: {
    maxRetries?: number, delay?: number, exponential?: boolean
}, errorAllowed?: (e: any) => boolean, abortSignal?: AbortSignal): Promise<T> {

    retryPolicy = retryPolicy || {};
    retryPolicy.maxRetries = retryPolicy.maxRetries || 5;
    retryPolicy.delay = retryPolicy.delay || 500;
    retryPolicy.exponential = retryPolicy.exponential == null ? true : retryPolicy.exponential;

    let err = null;

    for (let i = 0; i < retryPolicy.maxRetries; i++) {
        try {
            const resp: T = await func();
            return resp;
        } catch (e) {
            if (errorAllowed != null && errorAllowed(e)) throw e;
            err = e;
            console.error("tryWithRetries: " + i, e);
        }
        if (abortSignal != null && abortSignal.aborted) throw (abortSignal.reason || new Error("Aborted"));
        if (i !== retryPolicy.maxRetries - 1) {
            await timeoutPromise(retryPolicy.exponential ? retryPolicy.delay * Math.pow(2, i) : retryPolicy.delay, abortSignal);
        }
    }

    throw err;

}

/**
 * Mimics fetch API byt adds a timeout to the request
 *
 * @param input
 * @param init
 */
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit & {
    timeout?: number
}): Promise<Response> {
    if (init == null) init = {};
    if (init.timeout != null) init.signal = timeoutSignal(init.timeout, new Error("Network request timed out"), init.signal);

    return fetch(input, init).catch(e => {
        if (e.name === "AbortError") {
            throw init.signal.reason;
        } else {
            throw e;
        }
    });
}

/**
 * Sends an HTTP GET request through a fetch API, handles non 200 response codes as errors
 * @param url Send request to this URL
 * @param timeout Timeout (in milliseconds) for the request to conclude
 * @param abortSignal
 * @throws {RequestError} if non 200 response code was returned
 */
export async function httpGet<T>(url: string, timeout?: number, abortSignal?: AbortSignal): Promise<T> {
    const init = {
        method: "GET",
        timeout,
        signal: abortSignal
    };

    const response: Response = timeout == null ? await fetch(url, init) : await fetchWithTimeout(url, init);

    if (response.status !== 200) {
        let resp: string;
        try {
            resp = await response.text();
        } catch (e) {
            throw new RequestError(response.statusText, response.status);
        }
        throw RequestError.parse(resp, response.status);
    }

    return await response.json();
}

/**
 * Sends an HTTP POST request through a fetch API, handles non 200 response codes as errors
 * @param url Send request to this URL
 * @param body A HTTP request body to send to the server
 * @param timeout Timeout (in milliseconds) for the request to conclude
 * @param abortSignal
 * @throws {RequestError} if non 200 response code was returned
 */
export async function httpPost<T>(url: string, body: any, timeout?: number, abortSignal?: AbortSignal): Promise<T> {
    const init = {
        method: "POST",
        timeout,
        body: JSON.stringify(body),
        headers: {'Content-Type': 'application/json'},
        signal: abortSignal
    };

    const response: Response = timeout == null ? await fetch(url, init) : await fetchWithTimeout(url, init);

    if (response.status !== 200) {
        let resp: string;
        try {
            resp = await response.text();
        } catch (e) {
            throw new RequestError(response.statusText, response.status);
        }
        throw RequestError.parse(resp, response.status);
    }

    return await response.json();
}

/**
 * Returns a promise that resolves after given amount seconds
 *
 * @param timeout how many milliseconds to wait for
 * @param abortSignal
 */
export function timeoutPromise(timeout: number, abortSignal?: AbortSignal) {
    return new Promise((resolve, reject) => {
        if (abortSignal != null && abortSignal.aborted) {
            reject(abortSignal.reason);
            return;
        }
        let timeoutHandle = setTimeout(resolve, timeout);
        if (abortSignal != null) {
            abortSignal.addEventListener("abort", () => {
                if (timeoutHandle != null) clearTimeout(timeoutHandle);
                timeoutHandle = null;
                reject(abortSignal.reason);
            });
        }
    });
}

/**
 * Returns an abort signal that aborts after a specified timeout in milliseconds
 *
 * @param timeout Milliseconds to wait
 * @param abortReason Abort with this abort reason
 * @param abortSignal Abort signal to extend
 */
export function timeoutSignal(timeout: number, abortReason?: any, abortSignal?: AbortSignal): AbortSignal {
    if(timeout==null) return abortSignal;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(abortReason || new Error("Timed out")), timeout);
    if(abortSignal!=null) {
        abortSignal.addEventListener("abort", () => {
            clearTimeout(timeoutHandle);
            abortController.abort(abortSignal.reason);
        });
    }
    return abortController.signal;
}
