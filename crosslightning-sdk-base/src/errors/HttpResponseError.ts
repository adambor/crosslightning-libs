
export class HttpResponseError extends Error {

    constructor(msg: string) {
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, HttpResponseError.prototype);
    }

}
