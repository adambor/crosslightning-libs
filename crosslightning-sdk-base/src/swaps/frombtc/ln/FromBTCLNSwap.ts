import {decode as bolt11Decode} from "bolt11";
import {FromBTCLNWrapper} from "./FromBTCLNWrapper";
import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {
    AbstractSigner, ChainType,
    SignatureData,
    SignatureVerificationError,
    SwapCommitStatus,
    SwapData
} from "crosslightning-base";
import {BtcToken, isISwapInit, ISwapInit} from "../../ISwap";
import {Buffer} from "buffer";
import {LNURL, LNURLWithdraw, LNURLWithdrawParamsWithUrl} from "../../../utils/LNURL";
import {UserError} from "../../../errors/UserError";
import {
    IntermediaryAPI,
    PaymentAuthorizationResponse,
    PaymentAuthorizationResponseCodes
} from "../../../intermediaries/IntermediaryAPI";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {PaymentAuthError} from "../../../errors/PaymentAuthError";
import {getLogger, timeoutPromise, tryWithRetries} from "../../../utils/Utils";

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
        (obj.lnurlCallback==null || typeof(obj.lnurlCallback)==="string") &&
        isISwapInit(obj);
}

export class FromBTCLNSwap<T extends ChainType> extends IFromBTCSwap<T, FromBTCLNSwapState> {
    protected readonly TYPE = SwapType.FROM_BTCLN;

    protected readonly PRE_COMMIT_STATE = FromBTCLNSwapState.PR_PAID;
    protected readonly COMMIT_STATE = FromBTCLNSwapState.CLAIM_COMMITED;
    protected readonly CLAIM_STATE = FromBTCLNSwapState.CLAIM_CLAIMED;
    protected readonly FAIL_STATE = FromBTCLNSwapState.FAILED;

    protected readonly lnurlFailSignal: AbortController = new AbortController();

    protected readonly pr: string;
    protected readonly secret: string;

    lnurl?: string;
    lnurlK1?: string;
    lnurlCallback?: string;
    prPosted?: boolean = false;

    constructor(wrapper: FromBTCLNWrapper<T>, init: FromBTCLNSwapInit<T["Data"]>);
    constructor(wrapper: FromBTCLNWrapper<T>, obj: any);
    constructor(
        wrapper: FromBTCLNWrapper<T>,
        initOrObject: FromBTCLNSwapInit<T["Data"]> | any
    ) {
        if(isFromBTCLNSwapInit(initOrObject)) initOrObject.url += "/frombtcln";
        super(wrapper, initOrObject);
        if(isFromBTCLNSwapInit(initOrObject)) {
            this.state = FromBTCLNSwapState.PR_CREATED;
        } else {
            this.pr = initOrObject.pr;
            this.secret = initOrObject.secret;
            this.lnurl = initOrObject.lnurl;
            this.lnurlK1 = initOrObject.lnurlK1;
            this.lnurlCallback = initOrObject.lnurlCallback;
            this.prPosted = initOrObject.prPosted;
        }
        this.tryCalculateSwapFee();
        this.logger = getLogger(this.constructor.name+"("+this.getPaymentHashString()+"): ");
    }


    //////////////////////////////
    //// Getters & utils

    getInToken(): BtcToken<true> {
        return {
            chain: "BTC",
            lightning: true
        };
    }

    getPaymentHash(): Buffer {
        if(this.pr==null) return null;
        const decodedPR = bolt11Decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    /**
     * Returns the lightning network BOLT11 invoice that needs to be paid as an input to the swap
     */
    getLightningInvoice(): string {
        return this.pr;
    }

    getQrData(): string {
        return "lightning:"+this.getLightningInvoice().toUpperCase();
    }

    /**
     * Returns timeout time (in UNIX milliseconds) when the LN invoice will expire
     */
    getTimeoutTime(): number {
        if(this.pr==null) return null;
        const decoded = bolt11Decode(this.pr);
        return (decoded.timeExpireDate*1000);
    }

    isFinished(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_CLAIMED || this.state===FromBTCLNSwapState.QUOTE_EXPIRED || this.state===FromBTCLNSwapState.FAILED;
    }

    isClaimable(): boolean {
        return this.state===FromBTCLNSwapState.PR_PAID || this.state===FromBTCLNSwapState.CLAIM_COMMITED;
    }

    isSuccessful(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_CLAIMED;
    }

    isFailed(): boolean {
        return this.state===FromBTCLNSwapState.FAILED;
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

    canCommit(): boolean {
        return this.state===FromBTCLNSwapState.PR_PAID;
    }

    canClaim(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_COMMITED;
    }


    //////////////////////////////
    //// Amounts & fees

    getInAmount(): BN {
        const parsed = bolt11Decode(this.pr);
        return new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    /**
     * Estimated transaction fee for commit & claim txs combined
     */
    async getCommitAndClaimFee(): Promise<BN> {
        const commitFee = await tryWithRetries(() => this.getCommitFee());
        const claimFee = await tryWithRetries(() => this.getClaimFee());
        return commitFee.add(claimFee);
    }


    //////////////////////////////
    //// Payment

    /**
     * Waits till an LN payment is received by the intermediary and client can continue commiting & claiming the HTLC
     *
     * @param abortSignal Abort signal to stop waiting for payment
     * @param checkIntervalSeconds How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds: number = 5): Promise<void> {
        if(this.state!==FromBTCLNSwapState.PR_CREATED) throw new Error("Must be in PR_CREATED state!");

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));

        if(this.lnurl!=null && !this.prPosted) {
            LNURL.postInvoiceToLNURLWithdraw({k1: this.lnurlK1, callback: this.lnurlCallback}, this.pr).catch(e => {
                this.lnurlFailSignal.abort(e);
            });
            this.prPosted = true;
        }

        await this._save();

        let lnurlFailListener = () => abortController.abort(this.lnurlFailSignal.signal.reason);
        this.lnurlFailSignal.signal.addEventListener("abort", lnurlFailListener);
        this.lnurlFailSignal.signal.throwIfAborted();

        let resp: PaymentAuthorizationResponse = {code: PaymentAuthorizationResponseCodes.PENDING, msg: ""};
        while(!abortController.signal.aborted && resp.code===PaymentAuthorizationResponseCodes.PENDING) {
            resp = await IntermediaryAPI.getPaymentAuthorization(this.url, this.data.getHash());
            if(resp.code===PaymentAuthorizationResponseCodes.PENDING)
                await timeoutPromise(checkIntervalSeconds*1000, abortController.signal);
        }
        this.lnurlFailSignal.signal.removeEventListener("abort", lnurlFailListener);
        abortController.signal.throwIfAborted();

        if(resp.code===PaymentAuthorizationResponseCodes.AUTH_DATA) {
            const sigData = resp.data;
            const swapData = new this.wrapper.swapDataDeserializer(resp.data.data);
            await this.checkIntermediaryReturnedAuthData(this.getInitiator(), swapData, sigData);
            this.expiry = await tryWithRetries(() => this.wrapper.contract.getInitAuthorizationExpiry(
                swapData,
                sigData
            ));
            this.data = swapData;
            this.signatureData = {
                prefix: sigData.prefix,
                timeout: sigData.timeout,
                signature: sigData.signature
            };
            await this._saveAndEmit(FromBTCLNSwapState.PR_PAID);
        }

        if(this.state===FromBTCLNSwapState.PR_CREATED) throw new PaymentAuthError(resp.msg, resp.code, (resp as any).data);
    }

    /**
     * Checks whether the LP received the LN payment and we can continue by committing & claiming the HTLC on-chain
     *
     * @param save If the new swap state should be saved
     */
    async checkIntermediaryPaymentReceived(save: boolean = true): Promise<boolean | null> {
        if(
            this.state===FromBTCLNSwapState.PR_PAID ||
            this.state===FromBTCLNSwapState.CLAIM_COMMITED ||
            this.state===FromBTCLNSwapState.CLAIM_CLAIMED ||
            this.state===FromBTCLNSwapState.FAILED
        ) return true;
        if(this.state===FromBTCLNSwapState.QUOTE_EXPIRED) return false;
        const resp = await IntermediaryAPI.getPaymentAuthorization(this.url, this.data.getHash());
        switch(resp.code) {
            case PaymentAuthorizationResponseCodes.AUTH_DATA:
                const data = new this.wrapper.swapDataDeserializer(resp.data.data);
                try {
                    await this.checkIntermediaryReturnedAuthData(this.getInitiator(), data, resp.data);
                    this.expiry = await tryWithRetries(() => this.wrapper.contract.getInitAuthorizationExpiry(
                        data,
                        resp.data
                    ));
                    this.state = FromBTCLNSwapState.PR_PAID;
                    this.data = data;
                    this.signatureData = {
                        prefix: resp.data.prefix,
                        timeout: resp.data.timeout,
                        signature: resp.data.signature
                    };
                    if(save) await this._saveAndEmit();
                    return true;
                } catch (e) {}
                return null;
            case PaymentAuthorizationResponseCodes.EXPIRED:
                this.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                if(save) await this._saveAndEmit();
                return false;
            default:
                return null;
        }
    }

    /**
     * Checks the data returned by the intermediary in the payment auth request
     *
     * @param signer Smart chain signer's address initiating the swap
     * @param data Parsed swap data as returned by the intermediary
     * @param signature Signature data as returned by the intermediary
     * @protected
     * @throws {IntermediaryError} If the returned are not valid
     * @throws {SignatureVerificationError} If the returned signature is not valid
     * @throws {Error} If the swap is already committed on-chain
     */
    protected async checkIntermediaryReturnedAuthData(signer: string, data: T["Data"], signature: SignatureData): Promise<void> {
        data.setClaimer(signer);

        if (data.getOfferer() !== this.data.getOfferer()) throw new IntermediaryError("Invalid offerer used");
        if (!data.isToken(this.data.getToken())) throw new IntermediaryError("Invalid token used");
        if (data.getSecurityDeposit().gt(this.data.getSecurityDeposit())) throw new IntermediaryError("Invalid security deposit!");
        if (data.getAmount().lt(this.data.getAmount())) throw new IntermediaryError("Invalid amount received!");
        if (data.getHash() !== this.data.getHash()) throw new IntermediaryError("Invalid payment hash used!");

        await Promise.all([
            tryWithRetries(
                () => this.wrapper.contract.isValidInitAuthorization(data, signature, this.feeRate),
                null,
                SignatureVerificationError
            ),
            tryWithRetries<SwapCommitStatus>(
                () => this.wrapper.contract.getPaymentHashStatus(data.getHash())
            ).then(status => {
                if (status !== SwapCommitStatus.NOT_COMMITED)
                    throw new Error("Swap already committed on-chain!");
            })
        ]);
    }


    //////////////////////////////
    //// Commit

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     *
     * @param signer Signer to sign the transactions with, must be the same as used in the initialization
     * @param noWaitForConfirmation Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    async commit(signer: AbstractSigner, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        this.checkSigner(signer);
        let txResult = await super.commit(signer, noWaitForConfirmation, abortSignal, skipChecks);
        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }
        return txResult;
    }


    //////////////////////////////
    //// Claim

    /**
     * Returns transactions required for claiming the HTLC and finishing the swap by revealing the HTLC secret
     *  (hash preimage)
     *
     * @param signer Optional signer address to use for claiming the swap, can also be different from the initializer
     * @throws {Error} If in invalid state (must be CLAIM_COMMITED)
     */
    txsClaim(signer?: string): Promise<T["TX"][]> {
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) throw new Error("Must be in CLAIM_COMMITED state!");
        return this.wrapper.contract.txsClaimWithSecret(signer ?? this.getInitiator(), this.data, this.secret, true, true);
    }


    //////////////////////////////
    //// Commit & claim

    /**
     * Commits and claims the swap, in a way that the transactions can be signed together by the underlying provider and
     *  then sent sequentially
     *
     * @param signer Signer to sign the transactions with, must be the same as used in the initialization
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If in invalid state (must be PR_PAID or CLAIM_COMMITED)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    async commitAndClaim(signer: AbstractSigner, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string[]> {
        this.checkSigner(signer);
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return [null, await this.claim(signer, false, null)];

        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsCommitAndClaim(skipChecks), true, abortSignal
        );

        this.commitTxId = result[0] || this.commitTxId;
        this.claimTxId = result[result.length-1] || this.claimTxId;
        this.state = FromBTCLNSwapState.CLAIM_CLAIMED;

        await this._saveAndEmit(FromBTCLNSwapState.CLAIM_CLAIMED);
    }

    /**
     * Returns transactions for both commit & claim operation together, such that they can be signed all at once by
     *  the wallet. CAUTION: transactions must be sent sequentially, such that the claim (2nd) transaction is only
     *  sent after the commit (1st) transaction confirms. Failure to do so can reveal the HTLC pre-image too soon,
     *  opening a possibility for the LP to steal funds.
     *
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     *
     * @throws {Error} If in invalid state (must be PR_PAID or CLAIM_COMMITED)
     */
    async txsCommitAndClaim(skipChecks?: boolean): Promise<T["TX"][]> {
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return await this.txsClaim(this.getInitiator());
        if(this.state!==FromBTCLNSwapState.PR_PAID) throw new Error("Must be in PR_PAID state!");

        const initTxs = await this.txsCommit(skipChecks);
        const claimTxs = await this.wrapper.contract.txsClaimWithSecret(this.getInitiator(), this.data, this.secret, true, true, null, true);

        return initTxs.concat(claimTxs);
    }


    //////////////////////////////
    //// LNURL

    /**
     * Is this an LNURL-withdraw swap?
     */
    isLNURL(): boolean {
        return this.lnurl!=null;
    }

    /**
     * Gets the used LNURL or null if this is not an LNURL-withdraw swap
     */
    getLNURL(): string | null {
        return this.lnurl;
    }

    /**
     * Pay the generated lightning network invoice with LNURL-withdraw
     */
    async settleWithLNURLWithdraw(lnurl: string | LNURLWithdraw): Promise<void> {
        if(this.lnurl!=null) throw new Error("Cannot settle LNURL-withdraw swap with different LNURL");
        let lnurlParams: LNURLWithdrawParamsWithUrl;
        if(typeof(lnurl)==="string") {
            const parsedLNURL = await LNURL.getLNURL(lnurl);
            if(parsedLNURL==null || parsedLNURL.tag!=="withdrawRequest")
                throw new UserError("Invalid LNURL-withdraw to settle the swap");
            lnurlParams = parsedLNURL;
        } else {
            lnurlParams = lnurl.params;
        }
        LNURL.useLNURLWithdraw(lnurlParams, this.pr).catch(e => this.lnurlFailSignal.abort(e));
        this.lnurl = lnurlParams.url;
        this.lnurlCallback = lnurlParams.callback;
        this.lnurlK1 = lnurlParams.k1;
        this.prPosted = true;
        await this._saveAndEmit();
    }


    //////////////////////////////
    //// Storage

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
}