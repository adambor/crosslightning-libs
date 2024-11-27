import {decode as bolt11Decode} from "bolt11";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {ChainType, SwapData} from "crosslightning-base";
import {LnForGasWrapper} from "./LnForGasWrapper";
import {Buffer} from "buffer";
import {PaymentAuthError} from "../../../errors/PaymentAuthError";
import {getLogger, timeoutPromise} from "../../../utils/Utils";
import {Fee, isISwapInit, ISwap, ISwapInit} from "../../ISwap";
import {PriceInfoType} from "../../../prices/abstract/ISwapPrice";
import {
    InvoiceStatusResponseCodes,
    TrustedIntermediaryAPI
} from "../../../intermediaries/TrustedIntermediaryAPI";
import {BitcoinTokens, BtcToken, SCToken, TokenAmount, toTokenAmount} from "../../Tokens";

export enum LnForGasSwapState {
    EXPIRED = -2,
    FAILED = -1,
    PR_CREATED = 0,
    FINISHED = 1
}

export type LnForGasSwapInit<T extends SwapData> = ISwapInit<T> & {
    pr: string;
    outputAmount: BN;
    recipient: string;
};

export function isLnForGasSwapInit<T extends SwapData>(obj: any): obj is LnForGasSwapInit<T> {
    return typeof(obj.pr)==="string" &&
        BN.isBN(obj.outputAmount) &&
        typeof(obj.recipient)==="string" &&
        isISwapInit<T>(obj);
}

export class LnForGasSwap<T extends ChainType = ChainType> extends ISwap<T, LnForGasSwapState> {
    protected readonly TYPE: SwapType = SwapType.FROM_BTCLN;

    //State: PR_CREATED
    private readonly pr: string;
    private readonly outputAmount: BN;
    private readonly recipient: string;

    //State: FINISHED
    scTxId: string;

    constructor(wrapper: LnForGasWrapper<T>, init: LnForGasSwapInit<T["Data"]>);
    constructor(wrapper: LnForGasWrapper<T>, obj: any);
    constructor(
        wrapper: LnForGasWrapper<T>,
        initOrObj: LnForGasSwapInit<T["Data"]> | any
    ) {
        if(isLnForGasSwapInit(initOrObj)) initOrObj.url += "/lnforgas";
        super(wrapper, initOrObj);
        if(isLnForGasSwapInit(initOrObj)) {
            this.state = LnForGasSwapState.PR_CREATED;
        } else {
            this.pr = initOrObj.pr;
            this.outputAmount = initOrObj.outputAmount==null ? null : new BN(initOrObj.outputAmount);
            this.recipient = initOrObj.recipient;
            this.scTxId = initOrObj.scTxId;
        }
        this.tryCalculateSwapFee();
        this.logger = getLogger(this.constructor.name+"("+this.getPaymentHashString()+"): ");

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

    protected upgradeVersion() {
        if(this.version == null) {
            //Noop
            this.version = 1;
        }
    }

    /**
     * In case swapFee in BTC is not supplied it recalculates it based on swap price
     * @protected
     */
    protected tryCalculateSwapFee() {
        if(this.swapFeeBtc==null) {
            this.swapFeeBtc = this.swapFee.mul(this.getInput().rawAmount).div(this.getOutAmountWithoutFee());
        }
    }


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


    //////////////////////////////
    //// Getters & utils

    getTxId(): string | null {
        return this.scTxId;
    }

    getRecipient(): string {
        return this.recipient;
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

    /**
     * Returns a string that can be displayed as QR code representation of the lightning invoice (with lightning: prefix)
     */
    getQrData(): string {
        return "lightning:"+this.pr.toUpperCase();
    }

    getTimeoutTime(): number {
        if(this.pr==null) return null;
        const decoded = bolt11Decode(this.pr);
        return (decoded.timeExpireDate*1000);
    }

    isFinished(): boolean {
        return this.state===LnForGasSwapState.FINISHED || this.state===LnForGasSwapState.FAILED || this.state===LnForGasSwapState.EXPIRED;
    }

    isQuoteExpired(): boolean {
        return this.state===LnForGasSwapState.EXPIRED;
    }

    isQuoteSoftExpired(): boolean {
        return this.isQuoteExpired();
    }

    isFailed(): boolean {
        return this.state===LnForGasSwapState.FAILED;
    }

    isSuccessful(): boolean {
        return this.state===LnForGasSwapState.FINISHED;
    }

    isQuoteValid(): Promise<boolean> {
        return Promise.resolve(this.getTimeoutTime()>Date.now());
    }

    isActionable(): boolean {
        return false;
    }

    //////////////////////////////
    //// Amounts & fees

    protected getOutAmountWithoutFee(): BN {
        return this.outputAmount.add(this.swapFee);
    }

    getOutput(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.outputAmount, this.wrapper.tokens[this.wrapper.contract.getNativeCurrencyAddress()], this.wrapper.prices);
    }

    getInputWithoutFee(): TokenAmount<T["ChainId"], BtcToken<true>> {
        const parsed = bolt11Decode(this.pr);
        const amount = new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
        return toTokenAmount(amount.sub(this.swapFeeBtc), BitcoinTokens.BTCLN, this.wrapper.prices);
    }

    getInput(): TokenAmount<T["ChainId"], BtcToken<true>> {
        const parsed = bolt11Decode(this.pr);
        const amount = new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
        return toTokenAmount(amount, BitcoinTokens.BTCLN, this.wrapper.prices);
    }

    getSwapFee(): Fee {
        return {
            amountInSrcToken: toTokenAmount(this.swapFeeBtc, BitcoinTokens.BTCLN, this.wrapper.prices),
            amountInDstToken: toTokenAmount(this.swapFee, this.wrapper.tokens[this.wrapper.contract.getNativeCurrencyAddress()], this.wrapper.prices),
            usdValue: (abortSignal?: AbortSignal, preFetchedUsdPrice?: number) =>
                this.wrapper.prices.getBtcUsdValue(this.swapFeeBtc, abortSignal, preFetchedUsdPrice)
        };
    }

    getRealSwapFeePercentagePPM(): BN {
        const feeWithoutBaseFee = this.swapFeeBtc.sub(this.pricingInfo.satsBaseFee);
        return feeWithoutBaseFee.mul(new BN(1000000)).div(this.getInputWithoutFee().rawAmount);
    }


    //////////////////////////////
    //// Payment

    async checkInvoicePaid(save: boolean = true): Promise<boolean> {
        if(this.state===LnForGasSwapState.FAILED || this.state===LnForGasSwapState.EXPIRED) return false;
        if(this.state===LnForGasSwapState.FINISHED) return true;

        const decodedPR = bolt11Decode(this.pr);
        const paymentHash = decodedPR.tagsObject.payment_hash;

        const response = await TrustedIntermediaryAPI.getInvoiceStatus(
            this.url, paymentHash, this.wrapper.options.getRequestTimeout
        );
        switch(response.code) {
            case InvoiceStatusResponseCodes.PAID:
                const txStatus = await this.wrapper.contract.getTxIdStatus(response.data.txId);
                if(txStatus==="success") {
                    this.state = LnForGasSwapState.FINISHED;
                    this.scTxId = response.data.txId;
                    if(save) await this._save();
                    return true;
                }
                return null;
            case InvoiceStatusResponseCodes.EXPIRED:
                this.state = LnForGasSwapState.EXPIRED;
                if(save) await this._save();
                return false;
            case InvoiceStatusResponseCodes.PENDING:
            case InvoiceStatusResponseCodes.TX_SENT:
            case InvoiceStatusResponseCodes.AWAIT_PAYMENT:
                return null;
            default:
                this.state = LnForGasSwapState.FAILED;
                if(save) await this._save();
                return false;
        }
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal Abort signal
     * @param checkIntervalSeconds How often to poll the intermediary for answer
     * @throws {PaymentAuthError} If swap expired or failed
     * @throws {Error} When in invalid state (not PR_CREATED)
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds: number = 5): Promise<void> {
        if(this.state!==LnForGasSwapState.PR_CREATED) throw new Error("Must be in PR_CREATED state!");

        this.initiated = true;
        await this._saveAndEmit();

        while(!abortSignal.aborted && this.state===LnForGasSwapState.PR_CREATED) {
            await this.checkInvoicePaid(true);
            if(this.state===LnForGasSwapState.PR_CREATED) await timeoutPromise(checkIntervalSeconds*1000, abortSignal);
        }

        if(this.isQuoteExpired()) throw new PaymentAuthError("Swap expired");
        if(this.isFailed()) throw new PaymentAuthError("Swap failed");
    }


    //////////////////////////////
    //// Storage

    serialize(): any{
        return {
            ...super.serialize(),
            pr: this.pr,
            outputAmount: this.outputAmount==null ? null : this.outputAmount.toString(10),
            recipient: this.recipient,
            scTxId: this.scTxId
        };
    }

    getInitiator(): string {
        return this.recipient;
    }

}