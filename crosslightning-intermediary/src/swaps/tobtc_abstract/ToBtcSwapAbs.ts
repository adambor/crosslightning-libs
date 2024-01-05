import * as BN from "bn.js";
import {createHash} from "crypto";
import * as bitcoin from "bitcoinjs-lib";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "../SwapHandlerSwap";
import {PluginManager} from "../../plugins/PluginManager";
import {FromBtcLnSwapState, SwapHandlerType} from "../..";

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

export class ToBtcSwapAbs<T extends SwapData> extends SwapHandlerSwap<T> {

    state: ToBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    readonly networkFee: BN;
    readonly satsPerVbyte: BN;
    readonly nonce: BN;
    readonly preferedConfirmationTarget: number;
    readonly signatureExpiry: BN;
    refundAuthTimeout: BN;

    realNetworkFee: BN;
    txId: string;

    constructor(address: string, amount: BN, swapFee: BN, networkFee: BN, satsPerVbyte: BN, nonce: BN, preferedConfirmationTarget: number, signatureExpiry: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN, networkFee?: BN, satsPerVbyte?: BN, nonce?: BN, preferedConfirmationTarget?: number, signatureExpiry?: BN) {
        if(typeof(prOrObj)==="string") {
            super();
            this.state = ToBtcSwapState.SAVED;
            this.address = prOrObj;
            this.amount = amount;
            this.swapFee = swapFee;
            this.networkFee = networkFee;
            this.satsPerVbyte = satsPerVbyte;
            this.nonce = nonce;
            this.preferedConfirmationTarget = preferedConfirmationTarget;
            this.signatureExpiry = signatureExpiry;
        } else {
            super(prOrObj);
            this.state = prOrObj.state;
            this.address = prOrObj.address;
            this.amount = new BN(prOrObj.amount);
            this.swapFee = new BN(prOrObj.swapFee);
            this.networkFee = new BN(prOrObj.networkFee);
            this.satsPerVbyte = new BN(prOrObj.satsPerVbyte);
            this.nonce = new BN(prOrObj.nonce);
            this.preferedConfirmationTarget = prOrObj.preferedConfirmationTarget;
            this.signatureExpiry = prOrObj.signatureExpiry==null ? null : new BN(prOrObj.signatureExpiry);
            this.refundAuthTimeout = prOrObj.refundAuthTimeout==null ? null : new BN(prOrObj.refundAuthTimeout);

            this.txId = prOrObj.txId;
        }
        this.type = SwapHandlerType.TO_BTC;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.state = this.state;
        partialSerialized.address = this.address;
        partialSerialized.amount = this.amount.toString(10);
        partialSerialized.swapFee = this.swapFee.toString(10);
        partialSerialized.networkFee = this.networkFee.toString(10);
        partialSerialized.satsPerVbyte = this.satsPerVbyte.toString(10);
        partialSerialized.nonce = this.nonce.toString(10);
        partialSerialized.preferedConfirmationTarget = this.preferedConfirmationTarget;
        partialSerialized.signatureExpiry = this.signatureExpiry==null ? null : this.signatureExpiry.toString(10);
        partialSerialized.refundAuthTimeout = this.refundAuthTimeout==null ? null : this.refundAuthTimeout.toString(10);
        partialSerialized.txId = this.txId;
        return partialSerialized;
    }

    async setState(newState: ToBtcSwapState) {
        const oldState = this.state;
        this.state = newState;
        await PluginManager.swapStateChange(this, oldState);
    }

}
