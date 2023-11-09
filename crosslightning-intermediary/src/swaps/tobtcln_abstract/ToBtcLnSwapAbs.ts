import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "../SwapHandlerSwap";
import {PluginManager} from "../../plugins/PluginManager";
import {ToBtcSwapState} from "../..";

export enum ToBtcLnSwapState {
    REFUNDED = -3,
    CANCELED = -2,
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    PAID = 2,
    CLAIMED = 3
}

export class ToBtcLnSwapAbs<T extends SwapData> extends SwapHandlerSwap<T> {

    state: ToBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;
    readonly maxFee: BN;
    readonly signatureExpiry: BN;

    realRoutingFee: BN;
    secret: string;

    constructor(pr: string, swapFee: BN, maxFee: BN, signatureExpiry: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN, maxFee?: BN, signatureExpiry?: BN) {
        if(typeof(prOrObj)==="string") {
            super();
            this.state = ToBtcLnSwapState.SAVED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
            this.maxFee = maxFee;
            this.signatureExpiry = signatureExpiry;
        } else {
            super(prOrObj);
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            this.maxFee = new BN(prOrObj.maxFee);
            this.signatureExpiry = prOrObj.signatureExpiry==null ? null : new BN(prOrObj.signatureExpiry);
            this.secret = prOrObj.secret;
        }
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.state = this.state;
        partialSerialized.pr = this.pr;
        partialSerialized.swapFee = this.swapFee.toString(10);
        partialSerialized.maxFee = this.maxFee.toString(10);
        partialSerialized.signatureExpiry = this.signatureExpiry == null ? null : this.signatureExpiry.toString(10);
        partialSerialized.secret = this.secret;
        return partialSerialized;
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

    getHashBuffer(): Buffer {
        return Buffer.from(bolt11.decode(this.pr).tagsObject.payment_hash, "hex");
    }

    async setState(newState: ToBtcLnSwapState) {
        const oldState = this.state;
        this.state = newState;
        await PluginManager.swapStateChange(this, oldState);
    }

}