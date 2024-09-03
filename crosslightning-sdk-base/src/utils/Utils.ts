import {Buffer} from "buffer";
import createHash from "create-hash";
import * as BN from "bn.js";

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

export function extendAbortController(abortSignal?: AbortSignal) {
    const _abortController = new AbortController();
    if(abortSignal!=null) abortSignal.onabort = () => _abortController.abort(abortSignal.reason);
    return _abortController;
}
