import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {SwapHandlerType} from "../..";
import * as bolt11 from "bolt11";
import {FromBtcBaseSwap} from "../FromBtcBaseSwap";

export enum FromBtcLnSwapState {
    REFUNDED = -2,
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3,
    SETTLED = 4,
}

export class FromBtcLnSwapAbs<T extends SwapData = SwapData> extends FromBtcBaseSwap<T, FromBtcLnSwapState> {

    readonly pr: string;

    nonce: number;
    prefix: string;
    timeout: string;
    signature: string;
    feeRate: string;

    secret: string;

    constructor(pr: string, swapFee: BN, swapFeeInToken: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN, swapFeeInToken?: BN) {
        if(typeof(prOrObj)==="string") {
            super(swapFee, swapFeeInToken);
            this.state = FromBtcLnSwapState.CREATED;
            this.pr = prOrObj;
        } else {
            super(prOrObj);
            this.pr = prOrObj.pr;
            this.secret = prOrObj.secret;
            this.nonce = prOrObj.nonce;
            this.prefix = prOrObj.prefix;
            this.timeout = prOrObj.timeout;
            this.signature = prOrObj.signature;
            this.feeRate = prOrObj.feeRate;
        }
        this.type = SwapHandlerType.FROM_BTCLN;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.secret = this.secret;
        partialSerialized.nonce = this.nonce;
        partialSerialized.prefix = this.prefix;
        partialSerialized.timeout = this.timeout;
        partialSerialized.signature = this.signature;
        partialSerialized.feeRate = this.feeRate;
        return partialSerialized;
    }

    getSequence(): BN {
        return null;
    }

    isInitiated(): boolean {
        return this.state!==FromBtcLnSwapState.CREATED;
    }

    isFailed(): boolean {
        return this.state===FromBtcLnSwapState.CANCELED || this.state===FromBtcLnSwapState.REFUNDED;
    }

    isSuccess(): boolean {
        return this.state===FromBtcLnSwapState.SETTLED;
    }

    getTotalInputAmount(): BN {
        return new BN(bolt11.decode(this.pr).millisatoshis).add(new BN(999)).div(new BN(1000));
    }

}
