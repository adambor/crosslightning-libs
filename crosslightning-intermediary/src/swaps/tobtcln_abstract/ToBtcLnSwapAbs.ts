import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {SwapData} from "crosslightning-base";
import {SwapHandlerType} from "../..";
import {deserializeBN, serializeBN} from "../../utils/Utils";
import {ToBtcBaseSwap} from "../ToBtcBaseSwap";

export enum ToBtcLnSwapState {
    REFUNDED = -3,
    CANCELED = -2,
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    PAID = 2,
    CLAIMED = 3
}

export class ToBtcLnSwapAbs<T extends SwapData> extends ToBtcBaseSwap<T, ToBtcLnSwapState> {

    readonly pr: string;
    readonly signatureExpiry: BN;

    secret: string;

    constructor(pr: string, swapFee: BN, swapFeeInToken: BN, quotedNetworkFee: BN, quotedNetworkFeeInToken: BN, signatureExpiry: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN, swapFeeInToken?: BN, quotedNetworkFee?: BN, quotedNetworkFeeInToken?: BN, signatureExpiry?: BN) {
        if(typeof(prOrObj)==="string") {
            super(swapFee, swapFeeInToken, quotedNetworkFee, quotedNetworkFeeInToken);
            this.state = ToBtcLnSwapState.SAVED;
            this.pr = prOrObj;
            this.signatureExpiry = signatureExpiry;
        } else {
            super(prOrObj);
            this.pr = prOrObj.pr;
            this.signatureExpiry = deserializeBN(prOrObj.signatureExpiry);
            this.secret = prOrObj.secret;

            //Compatibility with older versions
            this.quotedNetworkFee ??= deserializeBN(prOrObj.maxFee);
            this.realNetworkFee ??= deserializeBN(prOrObj.realRoutingFee);
        }
        this.type = SwapHandlerType.TO_BTCLN;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.signatureExpiry = serializeBN(this.signatureExpiry);
        partialSerialized.secret = this.secret;
        return partialSerialized;
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

    getHashBuffer(): Buffer {
        return Buffer.from(bolt11.decode(this.pr).tagsObject.payment_hash, "hex");
    }

    isInitiated(): boolean {
        return this.state!==ToBtcLnSwapState.SAVED;
    }

    isFailed(): boolean {
        return this.state===ToBtcLnSwapState.NON_PAYABLE || this.state===ToBtcLnSwapState.CANCELED || this.state===ToBtcLnSwapState.REFUNDED;
    }

    isSuccess(): boolean {
        return this.state===ToBtcLnSwapState.CLAIMED;
    }

    getOutputAmount(): BN {
        return new BN(bolt11.decode(this.pr).millisatoshis).add(new BN(999)).div(new BN(1000));
    }

}