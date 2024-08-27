import {SwapType} from "./SwapType";
import {EventEmitter} from "events";
import * as BN from "bn.js";
import {Buffer} from "buffer";

export type PriceInfoType = {
    isValid: boolean,
    differencePPM: BN,
    satsBaseFee: BN,
    feePPM: BN
};

export abstract class ISwap {

    /**
     * Transaction IDs for the swap on the smart chain side
     */
    commitTxId: string;
    refundTxId?: string;
    claimTxId?: string;

    expiry?: number;

    pricingInfo: PriceInfoType;

    protected constructor(obj: any);
    protected constructor(pricingInfo: PriceInfoType);
    protected constructor(pricingInfoOrObj: PriceInfoType | any) {
        if(pricingInfoOrObj.isValid!=null && pricingInfoOrObj.differencePPM!=null) {
            this.pricingInfo = pricingInfoOrObj;
        } else {
            this.pricingInfo = {
                isValid: pricingInfoOrObj._isValid,
                differencePPM: pricingInfoOrObj._differencePPM==null ? null : new BN(pricingInfoOrObj._differencePPM),
                satsBaseFee: pricingInfoOrObj._satsBaseFee==null ? null : new BN(pricingInfoOrObj._satsBaseFee),
                feePPM: pricingInfoOrObj._feePPM==null ? null : new BN(pricingInfoOrObj._feePPM)
            }
        }
    }

    hasValidPrice(): boolean {
        return this.pricingInfo==null ? null : this.pricingInfo.isValid;
    }

    getPriceDifferencePPM(): BN {
        return this.pricingInfo==null ? null :this.pricingInfo.differencePPM;
    }

    getPriceDifferencePct(): number {
        return this.pricingInfo==null ? null : this.pricingInfo.differencePPM==null ? null : this.pricingInfo.differencePPM.toNumber()/1000000;
    }

    abstract refetchPriceData(): Promise<PriceInfoType>;

    /**
     * Returns hash identifier of the swap
     */
    abstract getPaymentHash(): Buffer;

    /**
     * Returns the bitcoin address or bitcoin lightning network invoice
     */
    abstract getAddress(): string;

    /**
     * Returns amount that will be received
     */
    abstract getOutAmount(): BN;

    /**
     * Returns amount that will be sent out
     */
    abstract getInAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    abstract getFee(): BN;

    /**
     * Returns the type of the swap
     */
    abstract getType(): SwapType;

    /**
     * Get the estimated smart chain fee of the commit transaction
     */
    abstract getCommitFee(): Promise<BN>;

    /**
     * Returns expiry in UNIX millis
     */
    abstract getExpiry(): number;

    /**
     * Returns whether the swap is finished and in its terminal state (this can mean successful, refunded or failed)
     */
    abstract isFinished(): boolean;

    /**
     * Event emitter emitting "swapState" event when swap's state changes
     */
    events: EventEmitter;

    serialize(): any {
        if(this.pricingInfo==null) return {};
        return {
            _isValid: this.pricingInfo.isValid,
            _differencePPM: this.pricingInfo.differencePPM==null ? null :this.pricingInfo.differencePPM.toString(10),
            _satsBaseFee: this.pricingInfo.satsBaseFee==null ? null :this.pricingInfo.satsBaseFee.toString(10),
            _feePPM: this.pricingInfo.feePPM==null ? null :this.pricingInfo.feePPM.toString(10)
        }
    }

    abstract save(): Promise<void>;

}
