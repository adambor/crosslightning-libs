
import {IBTCxtoSolWrapper} from "./IBTCxtoSolWrapper";
import {ISwap} from "../ISwap";
import * as BN from "bn.js";
import * as EventEmitter from "events";
import {SwapType} from "../SwapType";
import {SwapData} from "crosslightning-base";


export abstract class IBTCxtoSolSwap<T extends SwapData> implements ISwap {

    readonly url: string;

    //State: PR_PAID
    data: T;
    swapFee: BN;
    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    protected readonly wrapper: IBTCxtoSolWrapper<T>;

    /**
     * Swap's event emitter
     *
     * @event IBTCxtoSolSwap<T>#swapState
     * @type {IBTCxtoSolSwap<T>}
     */
    readonly events: EventEmitter;

    protected constructor(
        wrapper: IBTCxtoSolWrapper<T>,
        urlOrObject?: string | any,
        data?: T,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
    ) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(typeof(urlOrObject)==="string") {
            this.url = urlOrObject;

            this.data = data;
            this.swapFee = swapFee;
            this.prefix = prefix;
            this.timeout = timeout;
            this.signature = signature;
            this.nonce = nonce;
        } else {
            this.url = urlOrObject.url;

            this.data = urlOrObject.data !=null ? new wrapper.swapDataDeserializer(urlOrObject.data) : null;
            this.swapFee = urlOrObject.swapFee==null ? null : new BN(urlOrObject.swapFee);
            this.prefix = urlOrObject.prefix;
            this.timeout = urlOrObject.timeout;
            this.signature = urlOrObject.signature;
            this.nonce = urlOrObject.nonce;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    abstract getOutAmount(): BN;

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    abstract getInAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN {
        return this.swapFee;
    }

    getOutAmountWithoutFee(): BN {
        return this.getOutAmount().add(this.getFee());
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    abstract waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number, updateCallback?: (txId: string, confirmations: number, targetConfirmations: number) => void): Promise<void>;

    /**
     * Returns if the swap can be committed
     */
    abstract canCommit(): boolean;

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    abstract commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    abstract waitTillCommited(abortSignal?: AbortSignal): Promise<void>;

    /**
     * Returns if the swap can be claimed
     */
    abstract canClaim(): boolean;

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    abstract claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;

    /**
     * Returns a promise that resolves when swap is claimed
     *
     * @param abortSignal   AbortSignal
     */
    abstract waitTillClaimed(abortSignal?: AbortSignal): Promise<void>;

    // /**
    //  * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
    //  * If swap is already commited, it just signs and executes the claim transaction
    //  *
    //  * @param signer            Signer to use to send the claim transaction
    //  * @param abortSignal       Abort signal
    //  */
    // commitAndClaim(signer: AnchorProvider, abortSignal?: AbortSignal): Promise<TransactionSignature[]>;

    // /**
    //  * Returns current state of the swap
    //  */
    // getState(): BTCxtoSolSwapState;

    /**
     * @fires BTCtoSolWrapper#swapState
     * @fires BTCtoSolSwap#swapState
     */
    abstract emitEvent(): void;

    /**
     * Get payment hash
     */
    abstract getPaymentHash(): Buffer;

    /**
     * Returns a string that can be displayed as QR code representation of the address (with bitcoin: or lightning: prefix)
     */
    abstract getQrData(): string;

    /**
     * Returns a bitcoin address/lightning network invoice of the swap.
     */
    abstract getAddress(): string;

    getWrapper(): IBTCxtoSolWrapper<T> {
        return this.wrapper;
    }

    abstract getType(): SwapType;

    save(): Promise<void> {
        return this.wrapper.storage.saveSwapData(this);
    }

    serialize(): any{
        return {
            url: this.url,

            data: this.data!=null ? this.data.serialize() : null,
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            nonce: this.nonce
        };
    }

    getCommitFee(): Promise<BN> {
        return this.getWrapper().contract.swapContract.getCommitFee();
    }

    getClaimFee(): Promise<BN> {
        return this.getWrapper().contract.swapContract.getClaimFee();
    }

}

export enum BTCxtoSolSwapState {
    FAILED = -1,
    PR_CREATED = 0,
    PR_PAID = 1,
    CLAIM_COMMITED = 2,
    CLAIM_CLAIMED = 3
}
