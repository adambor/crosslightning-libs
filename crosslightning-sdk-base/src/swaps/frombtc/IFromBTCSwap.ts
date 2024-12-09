
import {IFromBTCWrapper} from "./IFromBTCWrapper";
import {Fee, ISwap, ISwapInit} from "../ISwap";
import * as BN from "bn.js";
import {
    ChainType,
    SignatureVerificationError,
} from "crosslightning-base";
import {PriceInfoType} from "../../prices/abstract/ISwapPrice";
import {BtcToken, SCToken, TokenAmount, toTokenAmount} from "../Tokens";


export abstract class IFromBTCSwap<
    T extends ChainType = ChainType,
    S extends number = number
> extends ISwap<T, S> {
    protected abstract readonly inputToken: BtcToken;

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
            this.swapFeeBtc = this.swapFee.mul(this.getInput().rawAmount).div(this.getOutAmountWithoutFee());
        }

        if(this.pricingInfo.swapPriceUSatPerToken==null) {
            this.pricingInfo = this.wrapper.prices.recomputePriceInfoReceive(
                this.chainIdentifier,
                this.getInput().rawAmount,
                this.pricingInfo.satsBaseFee,
                this.pricingInfo.feePPM,
                this.data.getAmount(),
                this.data.getToken()
            );
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
            this.getInput().rawAmount,
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
        return feeWithoutBaseFee.mul(new BN(1000000)).div(this.getInputWithoutFee().rawAmount);
    }


    //////////////////////////////
    //// Getters & utils

    /**
     * Returns the bitcoin address or lightning invoice to be paid for the swap
     */
    abstract getAddress(): string;

    /**
     * Returns a string that can be displayed as QR code representation of the address or lightning invoice
     *  (with bitcoin: or lightning: prefix)
     */
    abstract getQrData(): string;

    abstract isClaimable(): boolean;

    isActionable(): boolean {
        return this.isClaimable();
    }

    /**
     * Returns if the swap can be committed
     */
    abstract canCommit(): boolean;


    //////////////////////////////
    //// Amounts & fees

    protected getOutAmountWithoutFee(): BN {
        return this.data.getAmount().add(this.swapFee);
    }

    getOutputWithoutFee(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.data.getAmount().add(this.swapFee), this.wrapper.tokens[this.data.getToken()], this.wrapper.prices);
    }

    getOutput(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.data.getAmount(), this.wrapper.tokens[this.data.getToken()], this.wrapper.prices);
    }

    getInputWithoutFee(): TokenAmount<T["ChainId"], BtcToken> {
        return toTokenAmount(this.getInput().rawAmount.sub(this.swapFeeBtc), this.inputToken, this.wrapper.prices);
    }

    getSwapFee(): Fee {
        return {
            amountInSrcToken: toTokenAmount(this.swapFeeBtc, this.inputToken, this.wrapper.prices),
            amountInDstToken: toTokenAmount(this.swapFee, this.wrapper.tokens[this.data.getToken()], this.wrapper.prices),
            usdValue: (abortSignal?: AbortSignal, preFetchedUsdPrice?: number) =>
                this.wrapper.prices.getBtcUsdValue(this.swapFeeBtc, abortSignal, preFetchedUsdPrice)
        };
    }

    getSecurityDeposit(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.data.getSecurityDeposit(), this.wrapper.tokens[this.wrapper.contract.getNativeCurrencyAddress()], this.wrapper.prices);
    }

    getTotalDeposit(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.data.getTotalDeposit(), this.wrapper.tokens[this.wrapper.contract.getNativeCurrencyAddress()], this.wrapper.prices);
    }

    getInitiator(): string {
        return this.data.getClaimer();
    }

    getClaimFee(): Promise<BN> {
        return this.wrapper.contract.getClaimFee(this.getInitiator(), this.data);
    }


    //////////////////////////////
    //// Commit

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC or PTLC
     *
     * @param signer Signer to sign the transactions with, must be the same as used in the initialization
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    abstract commit(signer: T["Signer"], abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string>;

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

        this.initiated = true;
        await this._saveAndEmit();

        return await this.wrapper.contract.txsInit(
            this.data, this.signatureData,
            this.getTxoHash==null ? null : this.getTxoHash(), skipChecks, this.feeRate
        ).catch(e => Promise.reject(e instanceof SignatureVerificationError ? new Error("Request timed out") : e));
    }

    abstract waitTillCommited(abortSignal?: AbortSignal): Promise<void>;


    //////////////////////////////
    //// Claim

    /**
     * Claims and finishes the swap
     *
     * @param signer Signer to sign the transactions with, can also be different to the initializer
     * @param abortSignal Abort signal to stop waiting for transaction confirmation
     */
    abstract claim(signer: T["Signer"], abortSignal?: AbortSignal): Promise<string>;

    abstract txsClaim(signer?: T["Signer"]): Promise<T["TX"][]>;

    /**
     * Waits till the swap is successfully claimed
     *
     * @param abortSignal AbortSignal
     * @throws {Error} If swap is in invalid state (must be COMMIT)
     */
    abstract waitTillClaimed(abortSignal?: AbortSignal): Promise<void>;

}
