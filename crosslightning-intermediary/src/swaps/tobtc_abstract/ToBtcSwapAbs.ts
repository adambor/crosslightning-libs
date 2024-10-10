import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {SwapHandlerType} from "../..";
import {ToBtcBaseSwap} from "../ToBtcBaseSwap";
import {deserializeBN, serializeBN} from "../../utils/Utils";

export enum ToBtcSwapState {
    REFUNDED = -3,
    CANCELED = -2,
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    BTC_SENDING = 2,
    BTC_SENT = 3,
    CLAIMED = 4
}

export class ToBtcSwapAbs<T extends SwapData> extends ToBtcBaseSwap<T, ToBtcSwapState> {

    readonly address: string;
    readonly amount: BN;
    readonly satsPerVbyte: BN;
    readonly nonce: BN;
    readonly preferedConfirmationTarget: number;
    readonly signatureExpiry: BN;

    txId: string;

    constructor(address: string, amount: BN, swapFee: BN, swapFeeInToken: BN, networkFee: BN, networkFeeInToken: BN, satsPerVbyte: BN, nonce: BN, preferedConfirmationTarget: number, signatureExpiry: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN, swapFeeInToken?: BN, networkFee?: BN, networkFeeInToken?: BN, satsPerVbyte?: BN, nonce?: BN, preferedConfirmationTarget?: number, signatureExpiry?: BN) {
        if(typeof(prOrObj)==="string") {
            super(swapFee, swapFeeInToken, networkFee, networkFeeInToken);
            this.state = ToBtcSwapState.SAVED;
            this.address = prOrObj;
            this.amount = amount;
            this.satsPerVbyte = satsPerVbyte;
            this.nonce = nonce;
            this.preferedConfirmationTarget = preferedConfirmationTarget;
            this.signatureExpiry = signatureExpiry;
        } else {
            super(prOrObj);
            this.address = prOrObj.address;
            this.amount = new BN(prOrObj.amount);
            this.satsPerVbyte = new BN(prOrObj.satsPerVbyte);
            this.nonce = new BN(prOrObj.nonce);
            this.preferedConfirmationTarget = prOrObj.preferedConfirmationTarget;
            this.signatureExpiry = deserializeBN(prOrObj.signatureExpiry);

            this.txId = prOrObj.txId;

            //Compatibility
            this.quotedNetworkFee ??= deserializeBN(prOrObj.networkFee);
        }
        this.type = SwapHandlerType.TO_BTC;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.address = this.address;
        partialSerialized.amount = this.amount.toString(10);
        partialSerialized.satsPerVbyte = this.satsPerVbyte.toString(10);
        partialSerialized.nonce = this.nonce.toString(10);
        partialSerialized.preferedConfirmationTarget = this.preferedConfirmationTarget;
        partialSerialized.signatureExpiry = serializeBN(this.signatureExpiry);

        partialSerialized.txId = this.txId;
        return partialSerialized;
    }

    isInitiated(): boolean {
        return this.state!==ToBtcSwapState.SAVED;
    }

    isFailed(): boolean {
        return this.state===ToBtcSwapState.NON_PAYABLE || this.state===ToBtcSwapState.REFUNDED || this.state===ToBtcSwapState.CANCELED;
    }

    isSuccess(): boolean {
        return this.state===ToBtcSwapState.CLAIMED;
    }

    getOutputAmount(): BN {
        return this.amount;
    }

}
