
export class NetworkError extends Error {

    constructor(msg: string) {
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, NetworkError.prototype);
    }

}
