/**
 * An error or inconsistency in the intermediary's returned data, this will blacklist the intermediary
 */
export class IntermediaryError extends Error {

    constructor(msg: string) {
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, IntermediaryError.prototype);
    }

}
