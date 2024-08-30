import {IToBTCWrapper} from "./IToBTCWrapper";
import {Fee, isISwapInit, ISwap, ISwapInit, PriceInfoType, Token} from "../ISwap";
import * as BN from "bn.js";
import {SignatureVerificationError, SwapCommitStatus, SwapData} from "crosslightning-base";
import {tryWithRetries} from "../../utils/RetryUtils";

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

    abstract _setPaymentResult(result: {secret?: string, txId?: string}): void;


    //////////////////////////////
    //// Pricing

    async refetchPriceData(): Promise<PriceInfoType> {
        if(this.pricingInfo==null) return null;
        const priceData = await this.wrapper.contract.swapPrice.isValidAmountSend(this.getOutAmount(), this.pricingInfo.satsBaseFee, this.pricingInfo.feePPM, this.data.getAmount(), this.data.getToken());
        this.pricingInfo = priceData;
        return priceData;
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
        return this.state===ToBTCSwapState.REFUNDABLE || (this.state===ToBTCSwapState.COMMITED && this.wrapper.contract.swapContract.isExpired(this.data));
    }

    isQuoteExpired(): boolean {
        return this.state===ToBTCSwapState.QUOTE_EXPIRED;
    }

    async isQuoteValid(): Promise<boolean> {
        try {
            await tryWithRetries(
                () => this.wrapper.contract.swapContract.isValidClaimInitAuthorization(
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
        return this.wrapper.contract.swapContract.getRefundFee(this.data);
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
        const result = await this.wrapper.contract.swapContract.sendAndConfirm(
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

        return await this.wrapper.contract.swapContract.txsInitPayIn(
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
            this.wrapper.contract.waitForRefundAuthorization(this.data, this.url, abortController.signal, checkIntervalSeconds)
        ]);

        if(typeof result !== "object") return true;

        if(!result.is_paid) {
            await this._saveAndEmit(ToBTCSwapState.REFUNDABLE);
            return false;
        } else {
            this._setPaymentResult(result);
            await this._save();
            return true;
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
        const result = await this.wrapper.contract.swapContract.sendAndConfirm(await this.txsRefund(), !noWaitForConfirmation, abortSignal)

        this.refundTxId = result[0];
        await this._saveAndEmit(ToBTCSwapState.REFUNDED);

        return result[0];
    }

    /**
     * Returns transactions for refunding the swap if the swap is in refundable state, you can check so with isRefundable()
     */
    async txsRefund(): Promise<any[]> {
        if(!this.isRefundable()) throw new Error("Must be in REFUNDABLE state or expired!");

        if(this.wrapper.contract.swapContract.isExpired(this.data)) {
            return await this.wrapper.contract.swapContract.txsRefund(this.data, true, true);
        } else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.data, this.url);
            if(res.is_paid) {
                throw new Error("Payment was successful");
            }
            return await this.wrapper.contract.swapContract.txsRefundWithAuthorization(this.data, res.timeout, res.prefix, res.signature, true, true);
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
