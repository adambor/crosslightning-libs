import {SwapType} from "./SwapType";
import {EventEmitter} from "events";
import * as BN from "bn.js";

export interface ISwap {

    /**
     * Transaction IDs for the swap on the smart chain side
     */
    commitTxId: string;
    refundTxId?: string;
    claimTxId?: string;

    expiry?: number;

    /**
     * Returns hash identifier of the swap
     */
    getPaymentHash(): Buffer;

    /**
     * Returns the bitcoin address or bitcoin lightning network invoice
     */
    getAddress(): string;

    /**
     * Returns amount that will be received
     */
    getOutAmount(): BN;

    /**
     * Returns amount that will be sent out
     */
    getInAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN;

    /**
     * Returns the type of the swap
     */
    getType(): SwapType;

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): Promise<BN>;

    /**
     * Returns expiry in UNIX millis
     */
    getExpiry(): number;

    /**
     * Event emitter emitting "swapState" event when swap's state changes
     */
    events: EventEmitter;

    serialize(): any;
    save(): Promise<void>;

}
