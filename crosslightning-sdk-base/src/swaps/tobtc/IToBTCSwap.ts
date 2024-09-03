import {IToBTCWrapper} from "./IToBTCWrapper";
import {Fee, isISwapInit, ISwap, ISwapInit, Token} from "../ISwap";
import * as BN from "bn.js";
import {SignatureVerificationError, SwapCommitStatus, SwapData} from "crosslightning-base";
import {timeoutPromise, tryWithRetries} from "../../utils/RetryUtils";
import {PriceInfoType} from "../../prices/abstract/ISwapPrice";
import {
    IntermediaryAPI,
    RefundAuthorizationResponse,
    RefundAuthorizationResponseCodes
} from "../../intermediaries/IntermediaryAPI";
import {IntermediaryError} from "../../errors/IntermediaryError";

export type IToBTCSwapInit<T extends SwapData> = ISwapInit<T> & {
    networkFee: BN,
    networkFeeBtc?: BN
};

export function isIToBTCSwapInit<T extends SwapData>(obj: any): obj is IToBTCSwapInit<T> {
    return BN.isBN(obj.networkFee) &&
        (obj.networkFeeBtc==null || BN.isBN(obj.networkFeeBtc)) &&
        isISwapInit<T>(obj);
}

export abstract class IToBTCSwap<T extends SwapData> extends ISwap<T, ToBTCSwapState> {
    protected readonly networkFee: BN;
    protected networkFeeBtc?: BN;

    protected constructor(wrapper: IToBTCWrapper<T, IToBTCSwap<T>>, serializedObject: any);
    protected constructor(wrapper: IToBTCWrapper<T, IToBTCSwap<T>>, init: IToBTCSwapInit<T>);
    protected constructor(
        wrapper: IToBTCWrapper<T, IToBTCSwap<T>>,
        initOrObject: IToBTCSwapInit<T> | any
    ) {
        super(wrapper, initOrObject);
        if(isIToBTCSwapInit<T>(initOrObject)) {
            this.state = ToBTCSwapState.CREATED;
        } else {
            this.networkFee = initOrObject.networkFee==null ? null : new BN(initOrObject.networkFee);
            this.networkFeeBtc = initOrObject.networkFeeBtc==null ? null : new BN(initOrObject.networkFeeBtc);
        }
    }

    /**
     * In case swapFee in BTC is not supplied it recalculates it based on swap price
     * @protected
     */
    protected tryCalculateSwapFee() {
        if(this.swapFeeBtc==null) {
            this.swapFeeBtc = this.swapFee.mul(this.getOutAmount()).div(this.getInAmountWithoutFee());
        }
        if(this.networkFeeBtc==null) {
            this.networkFeeBtc = this.swapFee.mul(this.getOutAmount()).div(this.getInAmountWithoutFee());
        }
    }

    /**
     * Sets the payment result for the swap, optionally also checking it (checking that tx exist or swap secret is valid)
     *
     * @param result Result returned by the LP
     * @param check Whether to check the passed result
     * @returns true if check passed, false if check failed with a soft error (e.g. tx not yet found in the mempool)
     */
    abstract _setPaymentResult(result: {secret?: string, txId?: string}, check?: boolean): Promise<boolean>;


    //////////////////////////////
    //// Pricing

    async refreshPriceData(): Promise<PriceInfoType> {
        if(this.pricingInfo==null) return null;
        const priceData = await this.wrapper.prices.isValidAmountSend(this.getOutAmount(), this.pricingInfo.satsBaseFee, this.pricingInfo.feePPM, this.data.getAmount(), this.data.getToken());
        this.pricingInfo = priceData;
        return priceData;
    }

    getSwapPrice(): number {
        return 100000000000000/this.pricingInfo.swapPriceUSatPerToken.toNumber();
    }

    getMarketPrice(): number {
        return 100000000000000/this.pricingInfo.realPriceUSatPerToken.toNumber();
    }


    //////////////////////////////
    //// Getters & utils

    getInToken(): Token {
        return {
            chain: "SC",
            address: this.data.getToken()
        };
    }

    /**
     * Returns whether the swap is finished and in its terminal state (this can mean successful, refunded or failed)
     */
    isFinished(): boolean {
        return this.state===ToBTCSwapState.CLAIMED || this.state===ToBTCSwapState.REFUNDED || this.state===ToBTCSwapState.QUOTE_EXPIRED;
    }

    isRefundable(): boolean {
        return this.state===ToBTCSwapState.REFUNDABLE || (this.state===ToBTCSwapState.COMMITED && this.wrapper.contract.isExpired(this.data));
    }

    isQuoteExpired(): boolean {
        return this.state===ToBTCSwapState.QUOTE_EXPIRED;
    }

    async isQuoteValid(): Promise<boolean> {
        try {
            await tryWithRetries(
                () => this.wrapper.contract.isValidClaimInitAuthorization(
                    this.data, this.timeout, this.prefix, this.signature, this.feeRate
                ),
                null,
                e => e instanceof SignatureVerificationError
            );
            return true;
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                return false;
            }
        }
    }

    /**
     * Checks if the swap can be committed/started
     */
    canCommit(): boolean {
        return this.state===ToBTCSwapState.CREATED;
    }


    //////////////////////////////
    //// Amounts & fees

    getFee(): Fee {
        return {
            amountInSrcToken: this.swapFee.add(this.networkFee),
            amountInDstToken: this.swapFeeBtc.add(this.networkFeeBtc)
        }
    }

    getSwapFee(): Fee {
        return {
            amountInSrcToken: this.swapFee,
            amountInDstToken: this.swapFeeBtc
        };
    }

    /**
     * Returns network fee for the swap, the fee is represented in source currency & destination currency, but is
     *  paid only once
     */
    getNetworkFee(): Fee {
        return {
            amountInSrcToken: this.networkFee,
            amountInDstToken: this.networkFeeBtc
        };
    }

    getInAmountWithoutFee(): BN {
        return this.getInAmount().sub(this.swapFee.add(this.networkFee));
    }

    getInAmount(): BN {
        return this.data.getAmount();
    }

    /**
     * Get the estimated smart chain transaction fee of the refund transaction
     */
    getRefundFee(): Promise<BN> {
        return this.wrapper.contract.getRefundFee(this.data);
    }


    //////////////////////////////
    //// Commit

    /**
     * Commits the swap on-chain, initiating the swap
     *
     * @param noWaitForConfirmation Do not wait for transaction confirmation
     * @param abortSignal Abort signal
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled on swap creation, if you commit right after quoting, you can skipChecks)
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        const result = await this.wrapper.contract.sendAndConfirm(
            await this.txsCommit(skipChecks), !noWaitForConfirmation, abortSignal
        );

        this.commitTxId = result[0];
        await this._saveAndEmit(ToBTCSwapState.COMMITED);
        return result[0];
    }

    /**
     * Returns transactions for committing the swap on-chain, initiating the swap
     *
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled on swap creation, if you commit right after quoting, you can use skipChecks=true)
     */
    async txsCommit(skipChecks?: boolean): Promise<any[]> {
        if(!this.canCommit()) throw new Error("Must be in CREATED state!");

        await this._save();

        return await this.wrapper.contract.txsInitPayIn(
            this.data, this.timeout, this.prefix, this.signature, skipChecks, this.feeRate
        ).catch(e => Promise.reject(e instanceof SignatureVerificationError ? new Error("Request timed out") : e));
    }

    /**
     * Waits till a swap is committed, should be called after sending the commit transactions manually
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===ToBTCSwapState.COMMITED) return Promise.resolve();

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        await Promise.race([
            this.watchdogWaitTillCommited(abortController.signal),
            this.waitTillState(ToBTCSwapState.COMMITED, "gte", abortController.signal)
        ]);

        if(this.state<ToBTCSwapState.COMMITED) await this._saveAndEmit(ToBTCSwapState.COMMITED);
    }


    //////////////////////////////
    //// Payment

    /**
     * A blocking promise resolving when swap was concluded by the intermediary,
     *  rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<boolean> {
        if(this.state===ToBTCSwapState.CLAIMED) return Promise.resolve(true);

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const result = await Promise.race([
            this.waitTillState(ToBTCSwapState.CLAIMED, "eq", abortController.signal) as Promise<null>,
            this.waitTillIntermediarySwapProcessed(abortSignal, checkIntervalSeconds)
        ]);

        if(typeof result !== "object") return true;

        switch(result.code) {
            case RefundAuthorizationResponseCodes.PAID:
                await this._save();
                return true;
            case RefundAuthorizationResponseCodes.REFUND_DATA:
                await tryWithRetries(
                    () => this.wrapper.contract.isValidRefundAuthorization(
                        this.data,
                        result.data.timeout,
                        result.data.prefix,
                        result.data.signature
                    ),
                    null, e => e instanceof SignatureVerificationError
                );
                await this._saveAndEmit(ToBTCSwapState.REFUNDABLE);
                return false;
            case RefundAuthorizationResponseCodes.EXPIRED:
                if(this.wrapper.contract.isExpired(this.data)) throw new Error("Swap expired");
                throw new IntermediaryError("Swap expired");
            case RefundAuthorizationResponseCodes.NOT_FOUND:
                // @ts-ignore
                if(this.state===ToBTCSwapState.CLAIMED) return true;
                throw new Error("Intermediary swap not found");
        }
    }

    protected async waitTillIntermediarySwapProcessed(
        abortSignal?: AbortSignal,
        checkIntervalSeconds: number = 5
    ): Promise<RefundAuthorizationResponse> {
        let resp: RefundAuthorizationResponse = {code: RefundAuthorizationResponseCodes.PENDING, msg: ""};
        while(!abortSignal.aborted && resp.code===RefundAuthorizationResponseCodes.PENDING) {
            resp = await IntermediaryAPI.getRefundAuthorization(this.url, this.data.getHash(), this.data.getSequence());
            if(resp.code===RefundAuthorizationResponseCodes.PAID && !await this._setPaymentResult(resp.data, true)) {
                resp = {code: RefundAuthorizationResponseCodes.PENDING, msg: ""};
            }
            if(resp.code===RefundAuthorizationResponseCodes.PENDING) await timeoutPromise(checkIntervalSeconds, abortSignal);
        }
        return resp;
    }

    /**
     * Checks whether the swap was already processed by the LP and is either successful (requires proof which is
     *  either a HTLC pre-image for LN swaps or valid txId for on-chain swap) or failed and we can cooperatively
     *  refund.
     *
     * @param save whether to save the data
     * @returns true if swap is processed, false if the swap is still ongoing
     * @private
     */
    async checkIntermediarySwapProcessed(save: boolean = true): Promise<boolean> {
        if(this.state===ToBTCSwapState.CREATED || this.state==ToBTCSwapState.QUOTE_EXPIRED) return false;
        if(this.isFinished() || this.isRefundable()) return true;
        //Check if that maybe already concluded according to the LP
        const resp = await IntermediaryAPI.getRefundAuthorization(this.url, this.data.getHash(), this.data.getSequence());
        switch(resp.code) {
            case RefundAuthorizationResponseCodes.PAID:
                const processed = await this._setPaymentResult(resp.data, true);
                if(save) await this._saveAndEmit();
                return processed;
            case RefundAuthorizationResponseCodes.REFUND_DATA:
                await tryWithRetries(
                    () => this.wrapper.contract.isValidRefundAuthorization(this.data, resp.data.timeout, resp.data.prefix, resp.data.signature),
                    null, e => e instanceof SignatureVerificationError
                );
                this.state = ToBTCSwapState.REFUNDABLE;
                if(save) await this._saveAndEmit();
                return true;
            default:
                return false;
        }
    }

    //////////////////////////////
    //// Refund

    /**
     * Refunds the swap if the swap is in refundable state, you can check so with isRefundable()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async refund(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const result = await this.wrapper.contract.sendAndConfirm(await this.txsRefund(), !noWaitForConfirmation, abortSignal)

        this.refundTxId = result[0];
        await this._saveAndEmit(ToBTCSwapState.REFUNDED);

        return result[0];
    }

    /**
     * Returns transactions for refunding the swap if the swap is in refundable state, you can check so with isRefundable()
     */
    async txsRefund(): Promise<any[]> {
        if(!this.isRefundable()) throw new Error("Must be in REFUNDABLE state or expired!");

        if(this.wrapper.contract.isExpired(this.data)) {
            return await this.wrapper.contract.txsRefund(this.data, true, true);
        } else {
            const res = await IntermediaryAPI.getRefundAuthorization(this.url, this.data.getHash(), this.data.getSequence());
            if(res.code===RefundAuthorizationResponseCodes.REFUND_DATA) {
                return await this.wrapper.contract.txsRefundWithAuthorization(
                    this.data,
                    res.data.timeout,
                    res.data.prefix,
                    res.data.signature,
                    true,
                    true
                );
            }
            throw new IntermediaryError("Invalid intermediary cooperative message returned");
        }
    }

    /**
     * Waits till a swap is refunded, should be called after sending the refund transactions manually
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillRefunded(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===ToBTCSwapState.REFUNDED) return Promise.resolve();

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const res = await Promise.race([
            this.watchdogWaitTillResult(abortController.signal),
            this.waitTillState(ToBTCSwapState.REFUNDED, "eq", abortController.signal)
        ]);
        abortController.abort();

        if(res===SwapCommitStatus.PAID) {
            await this._saveAndEmit(ToBTCSwapState.CLAIMED);
        }
        if(res===SwapCommitStatus.NOT_COMMITED) {
            await this._saveAndEmit(ToBTCSwapState.REFUNDED);
        }
    }


    //////////////////////////////
    //// Storage

    serialize(): any {
        const obj = super.serialize();
        return {
            ...obj,
            networkFee: this.networkFee==null ? null : this.networkFee.toString(10),
            networkFeeBtc: this.networkFeeBtc==null ? null : this.networkFeeBtc.toString(10)
        };
    }

}

export enum ToBTCSwapState {
    REFUNDED = -2,
    QUOTE_EXPIRED = -1,
    CREATED = 0,
    COMMITED = 1,
    CLAIMED = 2,
    REFUNDABLE = 3
}
