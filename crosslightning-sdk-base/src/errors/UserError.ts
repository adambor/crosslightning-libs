
export class UserError extends Error {

    constructor(msg: string) {
        super(msg);
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, UserError.prototype);
    }

}

