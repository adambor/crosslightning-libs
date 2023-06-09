import {SoltoBTCWrapper} from "./SoltoBTCWrapper";
import {ISolToBTCxSwap, SolToBTCxSwapState} from "../ISolToBTCxSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";

export class SoltoBTCSwap<T extends SwapData> extends ISolToBTCxSwap<T> {

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;
    readonly confirmationTarget: number;

    readonly networkFee: BN;
    readonly swapFee: BN;
    readonly totalFee: BN;

    txId: string;

    constructor(
        wrapper: SoltoBTCWrapper<T>,
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
        expiry: number
    );
    constructor(wrapper: SoltoBTCWrapper<T>, obj: any);

    constructor(
        wrapper: SoltoBTCWrapper<T>,
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
        expiry?: number
    ) {
        if(typeof(addressOrObject)==="string") {
            super(wrapper, data, swapFee, prefix, timeout, signature, nonce, url, expiry);

            this.address = addressOrObject;
            this.amount = amount;
            this.confirmationTarget = confirmationTarget;
            this.networkFee = networkFee;
            this.totalFee = totalFee;
        } else {
            super(wrapper, addressOrObject);

            this.address = addressOrObject.address;
            this.amount = new BN(addressOrObject.amount);
            this.confirmationTarget = addressOrObject.confirmationTarget;
            this.networkFee = new BN(addressOrObject.networkFee);
            this.totalFee = new BN(addressOrObject.totalFee);
            this.txId = addressOrObject.txId;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN {
        return this.data.getAmount();
    }

    getFee(): BN {
        return this.totalFee;
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
        partialySerialized.networkFee = this.networkFee.toString(10);
        partialySerialized.totalFee = this.totalFee.toString(10);
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
            this.state = SolToBTCxSwapState.REFUNDABLE;

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

    getState(): SolToBTCxSwapState {
        return this.state;
    }

}
