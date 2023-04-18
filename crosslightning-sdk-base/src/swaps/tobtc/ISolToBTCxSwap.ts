
import {ISolToBTCxWrapper} from "./ISolToBTCxWrapper";
import {ISwap} from "../ISwap";
import * as BN from "bn.js";
import * as EventEmitter from "events";
import {SwapType} from "../SwapType";
import {SwapData} from "crosslightning-base";

export abstract class ISolToBTCxSwap<T extends SwapData> implements ISwap {

    state: SolToBTCxSwapState;

    readonly url: string;

    data: T;

    swapFee: BN;
    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    secret: string;

    readonly wrapper: ISolToBTCxWrapper<T>;

    /**
     * Swap's event emitter
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    protected constructor(
        wrapper: ISolToBTCxWrapper<T>,
        prOrObject: T | any,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
    ) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(prefix!=null || timeout!=null || signature!=null || nonce!=null || url!=null) {
            this.state = SolToBTCxSwapState.CREATED;

            this.url = url;

            this.data = prOrObject;

            this.swapFee = swapFee;
            this.prefix = prefix;
            this.timeout = timeout;
            this.signature = signature;
            this.nonce = nonce;
        } else {
            this.state = prOrObject.state;

            this.url = prOrObject.url;

            this.secret = prOrObject.secret;

            this.data = prOrObject.data!=null ? new wrapper.swapDataDeserializer(prOrObject.data) : null;

            this.swapFee = prOrObject.swapFee==null ? null : new BN(prOrObject.swapFee);
            this.prefix = prOrObject.prefix;
            this.timeout = prOrObject.timeout;
            this.signature = prOrObject.signature;
            this.nonce = prOrObject.nonce;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    abstract getInAmount(): BN;

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    abstract getOutAmount(): BN;

    /**
     * Get's the bitcoin address/lightning invoice of the recipient
     */
    abstract getAddress(): string;

    /**
     * Returns the payment hash
     */
    abstract getPaymentHash(): Buffer;

    abstract getType(): SwapType;

    /**
     * Returns calculated fee for the swap
     */
    abstract getFee(): BN;

    getInAmountWithoutFee(): BN {
        return this.getInAmount().sub(this.getFee());
    }

    /**
     * Returns if the swap can be committed/started
     */
    canCommit(): boolean {
        return this.state===SolToBTCxSwapState.CREATED;
    }

    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==SolToBTCxSwapState.CREATED) {
            throw new Error("Must be in CREATED state!");
        }

        console.log(this);

        try {
            await this.wrapper.contract.swapContract.isValidClaimInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            console.error(e);
            throw new Error("Expired, please retry");
        }

        const txResult = await this.wrapper.contract.swapContract.initPayIn(this.data, this.timeout, this.prefix, this.signature, this.nonce, !noWaitForConfirmation, abortSignal);

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

        return txResult;
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===SolToBTCxSwapState.COMMITED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===SolToBTCxSwapState.COMMITED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
                this.events.removeListener("swapState", listener);
                reject("Aborted");
            };
        });
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
            this.secret = result.secret;
            await this.save();

            return true;
        }
    }

    /**
     * Returns whether a swap can be already refunded
     */
    canRefund(): boolean {
        return this.state===SolToBTCxSwapState.REFUNDABLE || this.wrapper.contract.swapContract.isExpired(this.data);
    }

    /**
     * Attempts a refund of the swap back to the initiator
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async refund(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==SolToBTCxSwapState.REFUNDABLE && !this.wrapper.contract.swapContract.isExpired(this.data)) {
            throw new Error("Must be in REFUNDABLE state!");
        }

        let txResult: string;
        if(this.wrapper.contract.swapContract.isExpired(this.data)) {
            txResult = await this.wrapper.contract.swapContract.refund(this.data, true, true, !noWaitForConfirmation, abortSignal);
        } else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.data, this.url);
            if(res.is_paid) {
                throw new Error("Payment was successful");
            }
            txResult = await this.wrapper.contract.swapContract.refundWithAuthorization(this.data, res.timeout, res.prefix, res.signature, true, true, !noWaitForConfirmation, abortSignal);
        }

        if(!noWaitForConfirmation) {
            await this.waitTillRefunded(abortSignal);
            return txResult;
        }

        return txResult;
    }

    /**
     * Returns a promise that resolves when swap is refunded
     *
     * @param abortSignal   AbortSignal
     */
    waitTillRefunded(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===SolToBTCxSwapState.REFUNDED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===SolToBTCxSwapState.REFUNDED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
                this.events.removeListener("swapState", listener);
                reject("Aborted");
            };
        });
    }

    /**
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    serialize(): any{
        return {
            state: this.state,
            url: this.url,
            secret: this.secret,
            data: this.data!=null ? this.data.serialize() : null,
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            nonce: this.nonce
        };
    }

    save(): Promise<void> {
        return this.wrapper.storage.saveSwapData(this);
    }

    getTxId(): string {
        return this.secret;
    }

    /**
     * Returns the current state of the swap
     */
    getState(): SolToBTCxSwapState {
        return this.state;
    }

    getWrapper(): ISolToBTCxWrapper<T> {
        return this.wrapper;
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): BN {
        return this.getWrapper().contract.swapContract.getCommitFee();
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(): BN {
        return this.getWrapper().contract.swapContract.getRefundFee();
    }

}

export enum SolToBTCxSwapState {
    REFUNDED = -2,
    FAILED = -1,
    CREATED = 0,
    COMMITED = 1,
    CLAIMED = 2,
    REFUNDABLE = 3
}
