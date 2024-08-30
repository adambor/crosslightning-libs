
import {IFromBTCWrapper} from "./IFromBTCWrapper";
import {Fee, ISwap, ISwapInit, PriceInfoType, Token} from "../ISwap";
import * as BN from "bn.js";
import {EventEmitter} from "events";
import {SignatureVerificationError, SwapCommitStatus, SwapData, TokenAddress} from "crosslightning-base";
import {tryWithRetries} from "../../utils/RetryUtils";


export abstract class IFromBTCSwap<T extends SwapData, S extends number> extends ISwap<T, S> {

    protected abstract readonly COMMIT_STATE: S;
    protected abstract readonly CLAIM_STATE: S;
    protected abstract readonly FAIL_STATE: S;

    protected constructor(wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>, init: ISwapInit<T>);
    protected constructor(wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>, obj: any);
    protected constructor(
        wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>,
        initOrObj: ISwapInit<T> | any
    ) {
        super(wrapper, initOrObj);
    }

    /**
     * In case swapFee in BTC is not supplied it recalculates it based on swap price
     * @protected
     */
    protected tryCalculateSwapFee() {
        if(this.swapFeeBtc==null) {
            this.swapFeeBtc = this.swapFee.mul(this.getOutAmountWithoutFee()).div(this.getInAmount());
        }
    }

    abstract getTxoHash?(): Buffer;


    //////////////////////////////
    //// Pricing

    async refetchPriceData(): Promise<PriceInfoType> {
        if(this.pricingInfo==null) return null;
        const priceData = await this.wrapper.contract.swapPrice.isValidAmountReceive(this.getInAmount(), this.pricingInfo.satsBaseFee, this.pricingInfo.feePPM, this.data.getAmount(), this.data.getToken());
        this.pricingInfo = priceData;
        return priceData;
    }


    //////////////////////////////
    //// Getters & utils

    getOutToken(): Token {
        return {
            chain: "SC",
            address: this.data.getToken()
        };
    }

    async isQuoteValid(): Promise<boolean> {
        try {
            await tryWithRetries(
                () => this.wrapper.contract.swapContract.isValidInitAuthorization(
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
     * Returns a string that can be displayed as QR code representation of the address (with bitcoin: or lightning: prefix)
     */
    abstract getQrData(): string;

    abstract isClaimable(): boolean;

    abstract canCommit(): boolean;


    //////////////////////////////
    //// Amounts & fees

    protected getOutAmountWithoutFee(): BN {
        return this.getOutAmount().add(this.swapFee);
    }

    getOutAmount(): BN {
        return this.data.getAmount();
    }

    getInAmountWithoutFee(): BN {
        return this.getInAmount().sub(this.swapFeeBtc);
    }

    getSwapFee(): Fee {
        return {
            amountInSrcToken: this.swapFeeBtc,
            amountInDstToken: this.swapFee
        };
    }

    getClaimFee(): Promise<BN> {
        return this.wrapper.contract.swapContract.getClaimFee(this.data);
    }

    getSecurityDeposit(): BN {
        return this.data.getSecurityDeposit();
    }

    getTotalDeposit():BN {
        return this.data.getTotalDeposit();
    }


    //////////////////////////////
    //// Commit

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an PTLC
     * Important: Make sure this transaction is confirmed and only after it is display the address to user
     *
     * @param skipChecks                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        const result = await this.wrapper.contract.swapContract.sendAndConfirm(
            await this.txsCommit(skipChecks), !noWaitForConfirmation, abortSignal
        );

        this.commitTxId = result[0];
        await this._saveAndEmit(this.COMMIT_STATE);
        return result[0];
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an PTLC
     * Important: Make sure this transaction is confirmed and only after it is display the address to user
     */
    async txsCommit(skipChecks?: boolean): Promise<any[]> {
        if(!this.canCommit()) throw new Error("Must be in CREATED state!");

        await this._save();

        return await this.wrapper.contract.swapContract.txsInit(
            this.data, this.timeout, this.prefix, this.signature,
            this.getTxoHash==null ? null : this.getTxoHash(), skipChecks, this.feeRate
        ).catch(e => Promise.reject(e instanceof SignatureVerificationError ? new Error("Request timed out") : e));
    }

    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===this.COMMIT_STATE) return Promise.resolve();

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        await Promise.race([
            this.watchdogWaitTillCommited(abortController.signal),
            this.waitTillState(this.COMMIT_STATE, "gte", abortController.signal)
        ]);

        if(this.state<this.COMMIT_STATE) await this._saveAndEmit(this.COMMIT_STATE);
    }


    //////////////////////////////
    //// Claim

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const result = await this.wrapper.contract.swapContract.sendAndConfirm(
            await this.txsClaim(), !noWaitForConfirmation, abortSignal
        );

        this.claimTxId = result[0];
        await this._saveAndEmit(this.CLAIM_STATE);
        return result[0];
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     */
    abstract txsClaim(): Promise<any[]>;

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===this.CLAIM_STATE) return Promise.resolve();

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const res = await Promise.race([
            this.watchdogWaitTillResult(abortController.signal),
            this.waitTillState(this.CLAIM_STATE, "eq", abortController.signal)
        ]);

        if(res===SwapCommitStatus.PAID) {
            if(this.state<this.CLAIM_STATE) await this._saveAndEmit(this.CLAIM_STATE);
        }
        if(res===SwapCommitStatus.NOT_COMMITED || res===SwapCommitStatus.EXPIRED) {
            if(this.state>this.FAIL_STATE) await this._saveAndEmit(this.FAIL_STATE);
        }
    }


    //////////////////////////////
    //// Storage

    serialize(): any{
        const obj = super.serialize();
        return {
            ...obj,

            url: this.url,

            data: this.data!=null ? this.data.serialize() : null,
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            feeRate: this.feeRate==null ? null : this.feeRate,
            commitTxId: this.commitTxId,
            claimTxId: this.claimTxId,
            expiry: this.expiry
        };
    }

}
