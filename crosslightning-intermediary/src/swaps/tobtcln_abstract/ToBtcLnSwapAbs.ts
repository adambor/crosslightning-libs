import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "../SwapHandlerSwap";
import {PluginManager} from "../../plugins/PluginManager";
import {SwapHandlerType} from "../..";

export enum ToBtcLnSwapState {
    REFUNDED = -3,
    CANCELED = -2,
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    PAID = 2,
    CLAIMED = 3
}

export class ToBtcLnSwapAbs<T extends SwapData> extends SwapHandlerSwap<T, ToBtcLnSwapState> {

    readonly pr: string;
    readonly swapFee: BN;
    readonly maxFee: BN;
    readonly signatureExpiry: BN;
    // refundAuthTimeout: BN;

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
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            this.maxFee = new BN(prOrObj.maxFee);
            this.signatureExpiry = prOrObj.signatureExpiry==null ? null : new BN(prOrObj.signatureExpiry);
            // this.refundAuthTimeout = prOrObj.refundAuthTimeout==null ? null : new BN(prOrObj.refundAuthTimeout);
            this.realRoutingFee = prOrObj.realRoutingFee==null ? null : new BN(prOrObj.realRoutingFee);
            this.secret = prOrObj.secret;
        }
        this.type = SwapHandlerType.TO_BTCLN;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.swapFee = this.swapFee.toString(10);
        partialSerialized.maxFee = this.maxFee.toString(10);
        partialSerialized.signatureExpiry = this.signatureExpiry == null ? null : this.signatureExpiry.toString(10);
        // partialSerialized.refundAuthTimeout = this.refundAuthTimeout==null ? null : this.refundAuthTimeout.toString(10);
        partialSerialized.realRoutingFee = this.realRoutingFee == null ? null : this.realRoutingFee.toString(10);
        partialSerialized.secret = this.secret;
        return partialSerialized;
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

    getHashBuffer(): Buffer {
        return Buffer.from(bolt11.decode(this.pr).tagsObject.payment_hash, "hex");
    }

    getOutAmount(): BN {
        return new BN(bolt11.decode(this.pr).millisatoshis).add(new BN(999)).div(new BN(1000));
    }

}