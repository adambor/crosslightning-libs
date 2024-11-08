
import {IFromBTCWrapper} from "./IFromBTCWrapper";
import {BtcToken, Fee, ISwap, ISwapInit, SCToken} from "../ISwap";
import * as BN from "bn.js";
import {
    ChainType,
    SignatureVerificationError,
    SwapCommitStatus
} from "crosslightning-base";
import {PriceInfoType} from "../../prices/abstract/ISwapPrice";
import {extendAbortController, tryWithRetries} from "../../utils/Utils";


export abstract class IFromBTCSwap<
    T extends ChainType = ChainType,
    S extends number = number
> extends ISwap<T, S> {

    protected abstract readonly PRE_COMMIT_STATE: S;
    protected abstract readonly COMMIT_STATE: S;
    protected abstract readonly CLAIM_STATE: S;
    protected abstract readonly FAIL_STATE: S;

    protected constructor(wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>, init: ISwapInit<T["Data"]>);
    protected constructor(wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>, obj: any);
    protected constructor(
        wrapper: IFromBTCWrapper<T, IFromBTCSwap<T, S>>,
        initOrObj: ISwapInit<T["Data"]> | any
    ) {
        super(wrapper, initOrObj);
    }

    /**
     * In case swapFee in BTC is not supplied it recalculates it based on swap price
     * @protected
     */
    protected tryCalculateSwapFee() {
        if(this.swapFeeBtc==null) {
            this.swapFeeBtc = this.swapFee.mul(this.getInAmount()).div(this.getOutAmountWithoutFee());
        }
    }

    /**
     * Returns the txoHash to be used in init transactions
     */
    getTxoHash(): Buffer {return null;}


    //////////////////////////////
    //// Pricing

    async refreshPriceData(): Promise<PriceInfoType> {
        if(this.pricingInfo==null) return null;
        const priceData = await this.wrapper.prices.isValidAmountReceive(
            this.chainIdentifier,
            this.getInAmount(),
            this.pricingInfo.satsBaseFee,
            this.pricingInfo.feePPM,
            this.data.getAmount(),
            this.data.getToken()
        );
        this.pricingInfo = priceData;
        return priceData;
    }

    getSwapPrice(): number {
        return this.pricingInfo.swapPriceUSatPerToken.toNumber()/100000000000000;
    }

    getMarketPrice(): number {
        return this.pricingInfo.realPriceUSatPerToken.toNumber()/100000000000000;
    }

    getRealSwapFeePercentagePPM(): BN {
        const feeWithoutBaseFee = this.swapFeeBtc.sub(this.pricingInfo.satsBaseFee);
        return feeWithoutBaseFee.mul(new BN(1000000)).div(this.getInAmountWithoutFee());
    }


    //////////////////////////////
    //// Getters & utils

    abstract getInToken(): BtcToken;

    getOutToken(): SCToken {
        return {
            chain: "SC",
            chainId: this.chainIdentifier,
            address: this.data.getToken()
        };
    }

    async isQuoteValid(): Promise<boolean> {
        try {
            await tryWithRetries(
                () => this.wrapper.contract.isValidInitAuthorization(
                    this.data, this.signatureData, this.feeRate
                ),
                null,
                SignatureVerificationError
            );
            return true;
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                return false;
            }
        }
    }

    /**
     * Returns a string that can be displayed as QR code representation of the address or lightning invoice
     *  (with bitcoin: or lightning: prefix)
     */
    abstract getQrData(): string;

    abstract isClaimable(): boolean;

    /**
     * Returns if the swap can be committed
     */
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
        return this.wrapper.contract.getClaimFee(this.getInitiator(), this.data);
    }

    getSecurityDeposit(): BN {
        return this.data.getSecurityDeposit();
    }

    getTotalDeposit():BN {
        return this.data.getTotalDeposit();
    }

    getInitiator(): string {
        return this.data.getClaimer();
    }


    //////////////////////////////
    //// Commit

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC or PTLC
     *
     * @param signer Signer to sign the transactions with, must be the same as used in the initialization
     * @param noWaitForConfirmation Do not wait for transaction confirmation
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    async commit(signer: T["Signer"], noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        this.checkSigner(signer);
        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsCommit(skipChecks), !noWaitForConfirmation, abortSignal
        );

        this.commitTxId = result[0];
        await this._saveAndEmit(this.COMMIT_STATE);
        return result[0];
    }

    /**
     * Returns the transactions required for committing the swap on-chain, locking the tokens from the intermediary
     *  in an HTLC or PTLC
     *
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} When in invalid state to commit the swap
     */
    async txsCommit(skipChecks?: boolean): Promise<T["TX"][]> {
        if(!this.canCommit()) throw new Error("Must be in CREATED state!");

        await this._save();

        return await this.wrapper.contract.txsInit(
            this.data, this.signatureData,
            this.getTxoHash==null ? null : this.getTxoHash(), skipChecks, this.feeRate
        ).catch(e => Promise.reject(e instanceof SignatureVerificationError ? new Error("Request timed out") : e));
    }

    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===this.COMMIT_STATE || this.state===this.CLAIM_STATE) return Promise.resolve();
        if(this.state!==this.PRE_COMMIT_STATE) throw new Error("Invalid state");

        const abortController = extendAbortController(abortSignal);
        const result = await Promise.race([
            this.watchdogWaitTillCommited(abortController.signal).then(() => 0),
            this.waitTillState(this.COMMIT_STATE, "gte", abortController.signal).then(() => 1)
        ]);

        if(result===0) this.logger.debug("waitTillCommited(): Resolved from watchdog");
        if(result===1) this.logger.debug("waitTillCommited(): Resolved from state changed");

        if(this.state<this.COMMIT_STATE) await this._saveAndEmit(this.COMMIT_STATE);
    }


    //////////////////////////////
    //// Claim

    /**
     * Claims and finishes the swap
     *
     * @param signer Signer to sign the transactions with, can also be different to the initializer
     * @param noWaitForConfirmation Do not wait for transaction confirmation
     * @param abortSignal Abort signal to stop waiting for transaction confirmation
     */
    async claim(signer: T["Signer"], noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsClaim(signer.getAddress()), !noWaitForConfirmation, abortSignal
        );

        this.claimTxId = result[0];
        await this._saveAndEmit(this.CLAIM_STATE);
        return result[0];
    }

    abstract txsClaim(signer: string): Promise<T["TX"][]>;

    /**
     * Waits till the swap is successfully claimed
     *
     * @param abortSignal AbortSignal
     * @throws {Error} If swap is in invalid state (must be COMMIT)
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===this.CLAIM_STATE) return Promise.resolve();
        if(this.state!==this.COMMIT_STATE) throw new Error("Invalid state (not COMMIT)");

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const res = await Promise.race([
            this.watchdogWaitTillResult(abortController.signal),
            this.waitTillState(this.CLAIM_STATE, "eq", abortController.signal)
        ]);

        if(res==null) {
            this.logger.debug("waitTillClaimed(): Resolved from state change");
        } else {
            this.logger.debug("waitTillClaimed(): Resolved from watchdog");
        }

        if(res===SwapCommitStatus.PAID) {
            if(this.state<this.CLAIM_STATE) await this._saveAndEmit(this.CLAIM_STATE);
        }
        if(res===SwapCommitStatus.NOT_COMMITED || res===SwapCommitStatus.EXPIRED) {
            if(this.state>this.FAIL_STATE) await this._saveAndEmit(this.FAIL_STATE);
        }
    }

}
