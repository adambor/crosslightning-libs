import * as bolt11 from "bolt11";
import {FromBTCLNWrapper} from "./FromBTCLNWrapper";
import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {ISwapInit, Token} from "../../ISwap";
import {LNURLWithdraw} from "../../ClientSwapContract";
import {Buffer} from "buffer";

export enum FromBTCLNSwapState {
    QUOTE_EXPIRED = -2,
    FAILED = -1,
    PR_CREATED = 0,
    PR_PAID = 1,
    CLAIM_COMMITED = 2,
    CLAIM_CLAIMED = 3
}

export type FromBTCLNSwapInit<T extends SwapData> = ISwapInit<T> & {
    pr: string,
    secret: string,
    lnurl?: string,
    lnurlK1?: string,
    lnurlCallback?: string
};

export function isFromBTCLNSwapInit<T extends SwapData>(obj: any): obj is FromBTCLNSwapInit<T> {
    return typeof obj.pr==="string" &&
        typeof obj.secret==="string" &&
        (obj.lnurl==null || typeof(obj.lnurl)==="string") &&
        (obj.lnurlK1==null || typeof(obj.lnurlK1)==="string") &&
        (obj.lnurlCallback==null || typeof(obj.lnurlCallback)==="string");
}

export class FromBTCLNSwap<T extends SwapData> extends IFromBTCSwap<T, FromBTCLNSwapState> {
    protected readonly TYPE = SwapType.FROM_BTCLN;
    protected readonly COMMIT_STATE = FromBTCLNSwapState.CLAIM_COMMITED;
    protected readonly CLAIM_STATE = FromBTCLNSwapState.CLAIM_CLAIMED;
    protected readonly FAIL_STATE = FromBTCLNSwapState.FAILED;

    protected readonly pr: string;
    protected readonly secret: string;

    lnurl?: string;
    lnurlK1?: string;
    lnurlCallback?: string;
    prPosted?: boolean = false;
    callbackPromise?: Promise<void>;

    constructor(wrapper: FromBTCLNWrapper<T>, init: FromBTCLNSwapInit<T>);
    constructor(wrapper: FromBTCLNWrapper<T>, obj: any);
    constructor(
        wrapper: FromBTCLNWrapper<T>,
        initOrObject: FromBTCLNSwapInit<T> | any
    ) {
        super(wrapper, initOrObject);
        if(!isFromBTCLNSwapInit(initOrObject)) {
            this.pr = initOrObject.pr;
            this.secret = initOrObject.secret;
            this.lnurl = initOrObject.lnurl;
            this.lnurlK1 = initOrObject.lnurlK1;
            this.lnurlCallback = initOrObject.lnurlCallback;
            this.prPosted = initOrObject.prPosted;
        }
        this.tryCalculateSwapFee();
    }

    /**
     * Returns amount that will be sent on Bitcoin LN
     */
    getInAmount(): BN {
        const parsed = bolt11.decode(this.pr);
        return new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<void> {
        if(this.state!==FromBTCLNSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const abortController = new AbortController();

        if(abortSignal!=null) abortSignal.onabort = () => abortController.abort();

        console.log("Waiting for payment....");

        let callbackError = null;

        if(this.lnurl!=null && !this.prPosted) {
            this.callbackPromise = this.wrapper.contract.postInvoiceToLNURLWithdraw(this.pr, this.lnurlK1, this.lnurlCallback);
            this.prPosted = true;
        }

        this.wrapper.swapData[this.getPaymentHash().toString("hex")] = this;
        await this._save();

        let existingCallbackPromise;

        let changeListener = () => {
            if(existingCallbackPromise==null) {
                if(this.callbackPromise!=null) {
                    this.callbackPromise.catch(e => {
                        callbackError = e;
                        abortController.abort();
                    });
                    existingCallbackPromise = this.callbackPromise;
                }
            }
        };
        changeListener();
        this.events.addListener("swapState", changeListener);

        let result;
        try {
            result = await this.wrapper.contract.waitForIncomingPaymentAuthorization(
                this.pr,
                this.url,
                this.data.getToken(),
                this.data.getOfferer(),
                null,
                null,
                this.data.getSecurityDeposit(),
                this.data.getAmount(),
                this.feeRate,
                abortController.signal,
                checkIntervalSeconds
            );
        } catch (e) {
            this.events.removeListener("swapState", changeListener);
            if(callbackError!=null) throw callbackError;
            throw e;
        }
        this.events.removeListener("swapState", changeListener);

        if(abortController.signal.aborted) {
            if(callbackError!=null) throw callbackError;
            throw new Error("Aborted");
        }

        this.data = result.data;
        this.prefix = result.prefix;
        this.timeout = result.timeout;
        this.signature = result.signature;
        this.expiry = result.expiry;
        if(result.pricingInfo!=null) this.pricingInfo = result.pricingInfo;

        await this._saveAndEmit(FromBTCLNSwapState.PR_PAID);
    }

    /**
     * Pay the generated lightning network invoice with LNURL-withdraw
     */
    async settleWithLNURLWithdraw(lnurl: string | LNURLWithdraw, noInstantReceive?: boolean): Promise<void> {
        const result = await this.wrapper.contract.settleWithLNURLWithdraw(typeof(lnurl)==="string" ? lnurl : lnurl.params, this.pr, noInstantReceive);
        this.lnurl = typeof(lnurl)==="string" ? lnurl : lnurl.params.url;
        this.lnurlCallback = result.withdrawRequest.callback;
        this.lnurlK1 = result.withdrawRequest.k1;
        this.prPosted = !noInstantReceive;
        this.callbackPromise = result.lnurlCallbackResult;
        await this._save();
        await this._emitEvent();
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        return this.state===FromBTCLNSwapState.PR_PAID;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     * @param skipChecks                Skip checks like making sure init signature is still valid and swap wasn't commited yet (this is handled on swap creation, if you commit right after quoting, you can skipChecks)
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        let txResult = await super.commit(noWaitForConfirmation, abortSignal, skipChecks);
        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }
        return txResult;
    }

    /**
     * Returns if the swap can be claimed
     */
    canClaim(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_COMMITED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     */
    txsClaim(): Promise<any[]> {
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }
        return this.wrapper.contract.swapContract.txsClaimWithSecret(this.data, this.secret, true, true);
    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     *
     * @param abortSignal       Abort signal
     * @param skipChecks                Skip checks like making sure init signature is still valid and swap wasn't commited yet (this is handled on swap creation, if you commit right after quoting, you can skipChecks)
     */
    async commitAndClaim(abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string[]> {
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return [null, await this.claim(false, null)];

        const result = await this.wrapper.contract.swapContract.sendAndConfirm(
            await this.txsCommitAndClaim(skipChecks), true, abortSignal
        );

        this.commitTxId = result[0] || this.commitTxId;
        this.claimTxId = result[result.length-1] || this.claimTxId;
        this.state = FromBTCLNSwapState.CLAIM_CLAIMED;

        await this._saveAndEmit(FromBTCLNSwapState.CLAIM_CLAIMED);
    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     */
    async txsCommitAndClaim(skipChecks?: boolean): Promise<any[]> {
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return await this.txsClaim();
        if(this.state!==FromBTCLNSwapState.PR_PAID) throw new Error("Must be in PR_PAID state!");

        const initTxs = await this.txsCommit(skipChecks);
        const claimTxs = await this.wrapper.contract.swapContract.txsClaimWithSecret(this.data, this.secret, true, true);

        return initTxs.concat(claimTxs);
    }

    getPaymentHash(): Buffer {
        const decodedPR = bolt11.decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        if(this.wrapper.swapData[this.getPaymentHash().toString("hex")]==null && this.state==FromBTCLNSwapState.PR_CREATED) {
            this._save().catch(e => console.error(e));
        }
        return this.pr;
    }

    getQrData(): string {
        return "lightning:"+this.getAddress().toUpperCase();
    }

    /**
     * Estimated transaction fee for commitAndClaim tx
     */
    async getCommitAndClaimFee(): Promise<BN> {
        const commitFee = await tryWithRetries(() => this.getCommitFee());
        const claimFee = await tryWithRetries(() => this.getClaimFee());
        return commitFee.add(claimFee);
    }

    getTimeoutTime(): number {
        if(this.pr==null) return null;
        const decoded = bolt11.decode(this.pr);
        return (decoded.timeExpireDate*1000);
    }

    /**
     * Returns whether the swap is finished and in its terminal state (this can mean successful, refunded or failed)
     */
    isFinished(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_CLAIMED || this.state===FromBTCLNSwapState.QUOTE_EXPIRED || this.state===FromBTCLNSwapState.FAILED;
    }

    isClaimable(): boolean {
        return this.state===FromBTCLNSwapState.PR_PAID || this.state===FromBTCLNSwapState.CLAIM_COMMITED;
    }

    /**
     * Is this an LNURL-withdraw swap?
     */
    isLNURL(): boolean {
        return this.lnurl!=null;
    }

    /**
     * Gets the used LNURL or null if this is not an LNURL-pay swap
     */
    getLNURL(): string | null {
        return this.lnurl;
    }

    serialize(): any {
        return {
            ...super.serialize(),
            pr: this.pr,
            secret: this.secret,
            lnurl: this.lnurl,
            lnurlK1: this.lnurlK1,
            lnurlCallback: this.lnurlCallback,
            prPosted: this.prPosted
        };
    }

    getInToken(): Token {
        return {
            chain: "BTC",
            lightning: true
        };
    }

    isQuoteExpired(): boolean {
        return this.state===FromBTCLNSwapState.QUOTE_EXPIRED;
    }

    isQuoteValid(): Promise<boolean> {
        if(this.state===FromBTCLNSwapState.PR_CREATED) {
            return Promise.resolve(this.getTimeoutTime()>Date.now());
        }
        return super.isQuoteValid();
    }

    getTxoHash(): Buffer {
        return null;
    }

}