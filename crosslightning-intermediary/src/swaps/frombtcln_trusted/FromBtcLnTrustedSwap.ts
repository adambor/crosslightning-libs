import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {createHash} from "crypto";
import * as bolt11 from "@atomiqlabs/bolt11";
import {FromBtcBaseSwap} from "../FromBtcBaseSwap";

export enum FromBtcLnTrustedSwapState {
    REFUNDED = -2,
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    SENT = 2,
    CONFIRMED = 3,
    SETTLED = 4,
}

export class FromBtcLnTrustedSwap<T extends SwapData = SwapData> extends FromBtcBaseSwap<T, FromBtcLnTrustedSwapState> {

    readonly pr: string;
    readonly output: BN;
    readonly dstAddress: string;
    readonly secret: string;

    scRawTx: string;

    constructor(
        chainIdentifier: string,
        pr: string,
        swapFee: BN,
        swapFeeInToken: BN,
        output: BN,
        secret: string,
        dstAddress: string
    );
    constructor(obj: any);

    constructor(chainIdOrObj: string | any, pr?: string, swapFee?: BN, swapFeeInToken?: BN, output?: BN, secret?: string, dstAddress?: string) {
        if(typeof(chainIdOrObj)==="string") {
            super(chainIdOrObj, swapFee, swapFeeInToken);
            this.state = FromBtcLnTrustedSwapState.CREATED;
            this.pr = pr;
            this.output = output;
            this.secret = secret;
            this.dstAddress = dstAddress;
        } else {
            super(chainIdOrObj);
            this.pr = chainIdOrObj.pr;
            this.output = new BN(chainIdOrObj.output);
            this.secret = chainIdOrObj.secret;
            this.dstAddress = chainIdOrObj.dstAddress;
            this.scRawTx = chainIdOrObj.scRawTx;
        }
        this.type = null;
    }

    getHash(): string {
        return createHash("sha256").update(Buffer.from(this.secret, "hex")).digest().toString("hex");
    }

    getSequence(): BN {
        return new BN(0);
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.output = this.output.toString(10);
        partialSerialized.secret = this.secret;
        partialSerialized.dstAddress = this.dstAddress;
        partialSerialized.scRawTx = this.scRawTx;
        return partialSerialized;
    }

    getTotalInputAmount(): BN {
        return new BN(bolt11.decode(this.pr).millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    isFailed(): boolean {
        return this.state===FromBtcLnTrustedSwapState.CANCELED || this.state===FromBtcLnTrustedSwapState.REFUNDED;
    }

    isInitiated(): boolean {
        return this.state!==FromBtcLnTrustedSwapState.CREATED;
    }

    isSuccess(): boolean {
        return this.state===FromBtcLnTrustedSwapState.SETTLED;
    }

}
