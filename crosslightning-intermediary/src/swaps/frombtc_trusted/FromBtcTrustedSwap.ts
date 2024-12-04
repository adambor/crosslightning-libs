import {SwapData} from "crosslightning-base";
import {FromBtcBaseSwap} from "../FromBtcBaseSwap";
import * as BN from "bn.js";
import {deserializeBN, serializeBN} from "../../utils/Utils";
import {createHash} from "crypto";


export enum FromBtcTrustedSwapState {
    DOUBLE_SPENT = -3,
    REFUNDED = -2,
    EXPIRED = -1,
    CREATED = 0,
    RECEIVED = 1,
    BTC_CONFIRMED = 2,
    SENT = 3,
    CONFIRMED = 4,
    FINISHED = 5
}

export class FromBtcTrustedSwap<T extends SwapData = SwapData> extends FromBtcBaseSwap<T, FromBtcTrustedSwapState> {

    readonly btcAddress: string;
    readonly inputSats: BN;

    readonly dstAddress: string;
    readonly outputTokens: BN;

    readonly createdHeight: number;
    readonly expiresAt: number;
    readonly recommendedFee: number;
    readonly refundAddress: string;

    adjustedInput: BN;
    adjustedOutput: BN;

    doubleSpent: boolean;
    scRawTx: string;

    rawTx: string;
    txId: string;
    vout: number;

    burnTxId: string;
    refundTxId: string;

    constructor(
        chainIdentifier: string,
        swapFee: BN,
        swapFeeInToken: BN,
        btcAddress: string,
        inputSats: BN,
        dstAddress: string,
        outputTokens: BN,
        createdHeight: number,
        expiresAt: number,
        recommendedFee: number,
        refundAddress: string
    );
    constructor(obj: any);

    constructor(
        objOrChainIdentifier: any | string,
        swapFee?: BN,
        swapFeeInToken?: BN,
        btcAddress?: string,
        inputSats?: BN,
        dstAddress?: string,
        outputTokens?: BN,
        createdHeight?: number,
        expiresAt?: number,
        recommendedFee?: number,
        refundAddress?: string
    ) {
        if(typeof(objOrChainIdentifier)==="string") {
            super(objOrChainIdentifier, swapFee, swapFeeInToken);
            this.state = FromBtcTrustedSwapState.CREATED;
            this.doubleSpent = false;
            this.btcAddress = btcAddress;
            this.inputSats = inputSats;
            this.dstAddress = dstAddress;
            this.outputTokens = outputTokens;
            this.createdHeight = createdHeight;
            this.expiresAt = expiresAt;
            this.recommendedFee = recommendedFee;
            this.refundAddress = refundAddress;
        } else {
            super(objOrChainIdentifier);
            this.btcAddress = objOrChainIdentifier.btcAddress;
            this.inputSats = deserializeBN(objOrChainIdentifier.inputSats);
            this.dstAddress = objOrChainIdentifier.dstAddress;
            this.outputTokens = deserializeBN(objOrChainIdentifier.outputTokens);
            this.adjustedInput = deserializeBN(objOrChainIdentifier.adjustedInput);
            this.adjustedOutput = deserializeBN(objOrChainIdentifier.adjustedOutput);
            this.createdHeight = objOrChainIdentifier.createdHeight;
            this.expiresAt = objOrChainIdentifier.expiresAt;
            this.recommendedFee = objOrChainIdentifier.recommendedFee;
            this.refundAddress = objOrChainIdentifier.refundAddress;
            this.doubleSpent = objOrChainIdentifier.doubleSpent;
            this.scRawTx = objOrChainIdentifier.scRawTx;
            this.rawTx = objOrChainIdentifier.rawTx;
            this.txId = objOrChainIdentifier.txId;
            this.vout = objOrChainIdentifier.vout;
            this.burnTxId = objOrChainIdentifier.burnTxId;
            this.refundTxId = objOrChainIdentifier.refundTxId;
        }
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.btcAddress = this.btcAddress;
        partialSerialized.inputSats = serializeBN(this.inputSats);
        partialSerialized.dstAddress = this.dstAddress;
        partialSerialized.outputTokens = serializeBN(this.outputTokens);
        partialSerialized.adjustedInput = serializeBN(this.adjustedInput);
        partialSerialized.adjustedOutput = serializeBN(this.adjustedOutput);
        partialSerialized.createdHeight = this.createdHeight;
        partialSerialized.expiresAt = this.expiresAt;
        partialSerialized.recommendedFee = this.recommendedFee;
        partialSerialized.refundAddress = this.refundAddress;
        partialSerialized.doubleSpent = this.doubleSpent;
        partialSerialized.scRawTx = this.scRawTx;
        partialSerialized.rawTx = this.rawTx;
        partialSerialized.txId = this.txId;
        partialSerialized.vout = this.vout;
        partialSerialized.burnTxId = this.burnTxId;
        partialSerialized.refundTxId = this.refundTxId;
        return partialSerialized;
    }

    getHash(): string {
        return createHash("sha256").update(this.btcAddress).digest().toString("hex");
    }

    getSequence(): BN {
        return new BN(0);
    }

    getOutputAmount(): BN {
        return this.adjustedOutput || this.outputTokens;
    }

    getTotalInputAmount(): BN {
        return this.adjustedInput || this.inputSats;
    }

    isFailed(): boolean {
        return this.state===FromBtcTrustedSwapState.EXPIRED || this.state===FromBtcTrustedSwapState.REFUNDED || this.state===FromBtcTrustedSwapState.DOUBLE_SPENT;
    }

    isInitiated(): boolean {
        return this.state!==FromBtcTrustedSwapState.CREATED;
    }

    isSuccess(): boolean {
        return this.state===FromBtcTrustedSwapState.CONFIRMED;
    }

}