
export class AbortError extends Error {

    constructor() {
        super("Aborted by abort signal");
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, AbortError.prototype);
    }

}
