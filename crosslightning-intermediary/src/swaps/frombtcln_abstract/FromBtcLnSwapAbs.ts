import * as BN from "bn.js";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";

export enum FromBtcLnSwapState {
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3
}

export class FromBtcLnSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: FromBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    nonce: number;
    prefix: string;
    timeout: string;
    signature: string;

    data: T;
    secret: string;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        super();
        if(typeof(prOrObj)==="string") {
            this.state = FromBtcLnSwapState.CREATED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize(prOrObj.data);
            }
            this.secret = prOrObj.secret;
            this.nonce = prOrObj.nonce;
            this.prefix = prOrObj.prefix;
            this.timeout = prOrObj.timeout;
            this.signature = prOrObj.signature;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
            data: this.data==null ? null : this.data.serialize(),
            secret: this.secret,
            nonce: this.nonce,
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature
        }
    }

}
