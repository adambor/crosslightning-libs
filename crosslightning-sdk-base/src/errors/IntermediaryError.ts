
export class IntermediaryError extends Error {

    constructor(msg: string) {
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, IntermediaryError.prototype);
    }

}
