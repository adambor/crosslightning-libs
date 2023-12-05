import {ToBTCWrapper} from "./ToBTCWrapper";
import {IToBTCSwap, ToBTCSwapState} from "../IToBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {PriceInfoType} from "../../ISwap";

export class ToBTCSwap<T extends SwapData> extends IToBTCSwap<T> {

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;
    readonly confirmationTarget: number;

    readonly swapFee: BN;

    txId: string;

    constructor(
        wrapper: ToBTCWrapper<T>,
        address: string,
        amount: BN,
        confirmationTarget: number,
        networkFee: BN,
        swapFee: BN,
        totalFee: BN,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        url: string,
        expiry: number,
        pricing: PriceInfoType
    );
    constructor(wrapper: ToBTCWrapper<T>, obj: any);

    constructor(
        wrapper: ToBTCWrapper<T>,
        addressOrObject: string | any,
        amount?: BN,
        confirmationTarget?: number,
        networkFee?: BN,
        swapFee?: BN,
        totalFee?: BN,
        data?: T,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
        expiry?: number,
        pricing?: PriceInfoType
    ) {
        if(typeof(addressOrObject)==="string") {
            super(wrapper, data, networkFee, swapFee, prefix, timeout, signature, nonce, url, expiry, pricing);

            this.address = addressOrObject;
            this.amount = amount;
            this.confirmationTarget = confirmationTarget;
        } else {
            super(wrapper, addressOrObject);

            this.address = addressOrObject.address;
            this.amount = new BN(addressOrObject.amount);
            this.confirmationTarget = addressOrObject.confirmationTarget;
            this.txId = addressOrObject.txId;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN {
        return this.data.getAmount();
    }

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount(): BN {
        return this.amount
    }

    serialize(): any {
        const partialySerialized = super.serialize();

        partialySerialized.address = this.address;
        partialySerialized.amount = this.amount.toString(10);
        partialySerialized.confirmationTarget = this.confirmationTarget;
        partialySerialized.txId = this.txId;

        return partialySerialized;
    }

    /**
     * A blocking promise resolving when swap was concluded by the intermediary
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<boolean> {
        const result = await this.wrapper.contract.waitForRefundAuthorization(this.data, this.url, abortSignal, checkIntervalSeconds);

        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");

        if(!result.is_paid) {
            this.state = ToBTCSwapState.REFUNDABLE;

            await this.save();

            this.emitEvent();
            return false;
        } else {
            this.txId = result.txId;
            await this.save();

            return true;
        }
    }

    getTxId(): string {
        return this.txId;
    }

    getPaymentHash(): Buffer {
        return Buffer.from(this.data.getHash(), "hex");
    }

    getAddress(): string {
        return this.address;
    }

    getType(): SwapType {
        return SwapType.TO_BTC;
    }

    getState(): ToBTCSwapState {
        return this.state;
    }

}
