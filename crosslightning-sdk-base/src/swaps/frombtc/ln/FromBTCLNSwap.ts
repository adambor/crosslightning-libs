import {decode as bolt11Decode} from "bolt11";
import {FromBTCLNWrapper} from "./FromBTCLNWrapper";
import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {ChainType, SignatureData, SignatureVerificationError, SwapCommitStatus, SwapData} from "crosslightning-base";
import {isISwapInit, ISwapInit} from "../../ISwap";
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
import {extendAbortController, getLogger, timeoutPromise, tryWithRetries} from "../../../utils/Utils";
import {BitcoinTokens, BtcToken, TokenAmount, toTokenAmount} from "../../Tokens";

export enum FromBTCLNSwapState {
    FAILED = -4,
    QUOTE_EXPIRED = -3,
    QUOTE_SOFT_EXPIRED = -2,
    EXPIRED = -1,
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

export class FromBTCLNSwap<T extends ChainType = ChainType> extends IFromBTCSwap<T, FromBTCLNSwapState> {
    protected readonly inputToken: BtcToken<true> = BitcoinTokens.BTCLN;
    protected readonly TYPE = SwapType.FROM_BTCLN;

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

    protected upgradeVersion() {
        if (this.version == null) {
            switch (this.state) {
                case -2:
                    this.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                    break;
                case -1:
                    this.state = FromBTCLNSwapState.FAILED;
                    break;
                case 0:
                    this.state = FromBTCLNSwapState.PR_CREATED
                    break;
                case 1:
                    this.state = FromBTCLNSwapState.PR_PAID
                    break;
                case 2:
                    this.state = FromBTCLNSwapState.CLAIM_COMMITED
                    break;
                case 3:
                    this.state = FromBTCLNSwapState.CLAIM_CLAIMED
                    break;
            }
            this.version = 1;
        }
    }

    //////////////////////////////
    //// Getters & utils

    getPaymentHash(): Buffer {
        if(this.pr==null) return null;
        const decodedPR = bolt11Decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        return this.pr;
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

    isQuoteSoftExpired(): boolean {
        return this.state===FromBTCLNSwapState.QUOTE_EXPIRED || this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED;
    }

    isQuoteValid(): Promise<boolean> {
        if(
            this.state===FromBTCLNSwapState.PR_CREATED ||
            (this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED && this.signatureData==null)
        ) {
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

    getInput(): TokenAmount<T["ChainId"], BtcToken<true>> {
        const parsed = bolt11Decode(this.pr);
        const amount = new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
        return toTokenAmount(amount, this.inputToken, this.wrapper.prices);
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
        if(
            this.state!==FromBTCLNSwapState.PR_CREATED &&
            (this.state!==FromBTCLNSwapState.QUOTE_SOFT_EXPIRED || this.signatureData!=null)
        ) throw new Error("Must be in PR_CREATED state!");

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));

        if(this.lnurl!=null && !this.prPosted) {
            LNURL.postInvoiceToLNURLWithdraw({k1: this.lnurlK1, callback: this.lnurlCallback}, this.pr).catch(e => {
                this.lnurlFailSignal.abort(e);
            });
            this.prPosted = true;
        }

        this.initiated = true;
        await this._saveAndEmit();

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
            if(this.state===FromBTCLNSwapState.PR_CREATED || this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED) {
                await this._saveAndEmit(FromBTCLNSwapState.PR_PAID);
            }
            return;
        }

        if(this.state===FromBTCLNSwapState.PR_CREATED || this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED) {
            if(resp.code===PaymentAuthorizationResponseCodes.EXPIRED) {
                await this._saveAndEmit(FromBTCLNSwapState.QUOTE_EXPIRED);
            }

            throw new PaymentAuthError(resp.msg, resp.code, (resp as any).data);
        }
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
        if(this.state===FromBTCLNSwapState.QUOTE_EXPIRED || (this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED && this.signatureData!=null)) return false;
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
                    this.initiated = true;
                    if(save) await this._saveAndEmit();
                    return true;
                } catch (e) {}
                return null;
            case PaymentAuthorizationResponseCodes.EXPIRED:
                this.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                this.initiated = true;
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
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    async commit(signer: T["Signer"], abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        this.checkSigner(signer);
        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsCommit(skipChecks), true, abortSignal
        );

        this.commitTxId = result[0];
        if(this.state===FromBTCLNSwapState.PR_PAID || this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED) {
            await this._saveAndEmit(FromBTCLNSwapState.CLAIM_COMMITED);
        }
        return result[0];
    }

    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED || this.state===FromBTCLNSwapState.CLAIM_CLAIMED) return Promise.resolve();
        if(this.state!==FromBTCLNSwapState.PR_PAID && (this.state!==FromBTCLNSwapState.QUOTE_SOFT_EXPIRED && this.signatureData!=null)) throw new Error("Invalid state");

        const abortController = extendAbortController(abortSignal);
        const result = await Promise.race([
            this.watchdogWaitTillCommited(abortController.signal),
            this.waitTillState(FromBTCLNSwapState.CLAIM_COMMITED, "gte", abortController.signal).then(() => 0)
        ]);
        abortController.abort();

        if(result===0) this.logger.debug("waitTillCommited(): Resolved from state changed");
        if(result===true) this.logger.debug("waitTillCommited(): Resolved from watchdog - commited");
        if(result===false) {
            this.logger.debug("waitTillCommited(): Resolved from watchdog - signature expired");
            if(
                this.state===FromBTCLNSwapState.PR_PAID ||
                this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED
            ) {
                await this._saveAndEmit(FromBTCLNSwapState.QUOTE_EXPIRED);
            }
            return;
        }

        if(
            this.state===FromBTCLNSwapState.PR_PAID ||
            this.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED
        ) {
            await this._saveAndEmit(FromBTCLNSwapState.CLAIM_COMMITED);
        }
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
    txsClaim(signer?: T["Signer"]): Promise<T["TX"][]> {
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) throw new Error("Must be in CLAIM_COMMITED state!");
        return this.wrapper.contract.txsClaimWithSecret(signer ?? this.getInitiator(), this.data, this.secret, true, true);
    }

    /**
     * Claims and finishes the swap
     *
     * @param signer Signer to sign the transactions with, can also be different to the initializer
     * @param abortSignal Abort signal to stop waiting for transaction confirmation
     */
    async claim(signer: T["Signer"], abortSignal?: AbortSignal): Promise<string> {
        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsClaim(), true, abortSignal
        );

        this.claimTxId = result[0];
        await this._saveAndEmit(FromBTCLNSwapState.CLAIM_CLAIMED);
        return result[0];
    }

    /**
     * Waits till the swap is successfully claimed
     *
     * @param abortSignal AbortSignal
     * @throws {Error} If swap is in invalid state (must be BTC_TX_CONFIRMED)
     * @throws {Error} If the LP refunded sooner than we were able to claim
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCLNSwapState.CLAIM_CLAIMED) return Promise.resolve();
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) throw new Error("Invalid state (not CLAIM_COMMITED)");

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const res = await Promise.race([
            this.watchdogWaitTillResult(abortController.signal),
            this.waitTillState(FromBTCLNSwapState.CLAIM_CLAIMED, "eq", abortController.signal).then(() => 0),
            this.waitTillState(FromBTCLNSwapState.EXPIRED, "eq", abortController.signal).then(() => 1),
        ]);
        abortController.abort();

        if(res===0) {
            this.logger.debug("waitTillClaimed(): Resolved from state change (CLAIM_CLAIMED)");
            return;
        }
        if(res===1) {
            this.logger.debug("waitTillClaimed(): Resolved from state change (EXPIRED)");
            throw new Error("Swap expired during claiming");
        }
        this.logger.debug("waitTillClaimed(): Resolved from watchdog");

        if(res===SwapCommitStatus.PAID) {
            if((this.state as FromBTCLNSwapState)!==FromBTCLNSwapState.CLAIM_CLAIMED) await this._saveAndEmit(FromBTCLNSwapState.CLAIM_CLAIMED);
        }
        if(res===SwapCommitStatus.NOT_COMMITED || res===SwapCommitStatus.EXPIRED) {
            if(
                (this.state as FromBTCLNSwapState)!==FromBTCLNSwapState.CLAIM_CLAIMED &&
                (this.state as FromBTCLNSwapState)!==FromBTCLNSwapState.FAILED
            ) await this._saveAndEmit(FromBTCLNSwapState.FAILED);
        }
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
    async commitAndClaim(signer: T["Signer"], abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string[]> {
        this.checkSigner(signer);
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return [null, await this.claim(signer)];

        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsCommitAndClaim(skipChecks), true, abortSignal
        );

        this.commitTxId = result[0] || this.commitTxId;
        this.claimTxId = result[result.length-1] || this.claimTxId;
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
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) return await this.txsClaim();
        if(this.state!==FromBTCLNSwapState.PR_PAID && (this.state!==FromBTCLNSwapState.QUOTE_SOFT_EXPIRED || this.signatureData==null)) throw new Error("Must be in PR_PAID state!");

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