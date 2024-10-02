import {SwapData} from "crosslightning-base";
import {ToBtcSwapAbs} from "../tobtc_abstract/ToBtcSwapAbs";
import * as BN from "bn.js";
import {Psbt} from "bitcoinjs-lib";


export class ToOrdinalSwap<T extends SwapData> extends ToBtcSwapAbs<T> {

    psbt: Psbt;

    constructor(address: string, amount: BN, swapFee: BN, networkFee: BN, satsPerVbyte: BN, nonce: BN, preferedConfirmationTarget: number, signatureExpiry: BN, psbt: Psbt);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN, networkFee?: BN, satsPerVbyte?: BN, nonce?: BN, preferedConfirmationTarget?: number, signatureExpiry?: BN, psbt?: Psbt) {
        super(prOrObj, amount, swapFee, networkFee, satsPerVbyte, nonce, preferedConfirmationTarget, signatureExpiry);
        if(psbt!=null) {
            this.psbt = psbt;
        } else {
            this.psbt = prOrObj.psbt==null ? null : Psbt.fromHex(prOrObj.psbt);
        }
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.psbt = this.psbt==null ? null : this.psbt.toHex();
        return partialSerialized;
    }

}