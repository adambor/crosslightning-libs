import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";

export enum ToBtcLnSwapState {
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1
}

export class ToBtcLnSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: ToBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;
    readonly maxFee: BN;
    readonly signatureExpiry: BN;

    data: T;

    constructor(pr: string, swapFee: BN, maxFee: BN, signatureExpiry: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN, maxFee?: BN, signatureExpiry?: BN) {
        super();
        if(typeof(prOrObj)==="string") {
            this.state = ToBtcLnSwapState.SAVED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
            this.maxFee = maxFee;
            this.signatureExpiry = signatureExpiry;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            this.maxFee = new BN(prOrObj.maxFee);
            this.signatureExpiry = prOrObj.signatureExpiry==null ? null : new BN(prOrObj.signatureExpiry);

            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize(prOrObj.data);
            }
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
            maxFee: this.maxFee.toString(10),
            data: this.data==null ? null : this.data.serialize(),
            signatureExpiry: this.signatureExpiry==null ? null : this.signatureExpiry.toString(10)
        }
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

    getHashBuffer(): Buffer {
        return Buffer.from(bolt11.decode(this.pr).tagsObject.payment_hash, "hex");
    }

}