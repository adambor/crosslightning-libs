import {decode as bolt11Decode} from "bolt11";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {LnForGasWrapper} from "./LnForGasWrapper";
import {Buffer} from "buffer";
import {PaymentAuthError} from "../../../errors/PaymentAuthError";
import {timeoutPromise} from "../../../utils/Utils";
import {Fee, isISwapInit, ISwap, ISwapInit, Token} from "../../ISwap";
import {PriceInfoType} from "../../../prices/abstract/ISwapPrice";
import {
    InvoiceStatusResponseCodes,
    TrustedIntermediaryAPI
} from "../../../intermediaries/TrustedIntermediaryAPI";

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

export class LnForGasSwap<T extends SwapData> extends ISwap<T, LnForGasSwapState> {
    protected readonly TYPE: SwapType = SwapType.FROM_BTCLN;

    //State: PR_CREATED
    private readonly pr: string;
    private readonly outputAmount: BN;
    private readonly recipient: string;

    //State: FINISHED
    scTxId: string;

    constructor(wrapper: LnForGasWrapper<T>, init: LnForGasSwapInit<T>);
    constructor(wrapper: LnForGasWrapper<T>, obj: any);
    constructor(
        wrapper: LnForGasWrapper<T>,
        initOrObj: LnForGasSwapInit<T> | any
    ) {
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


    //////////////////////////////
    //// Pricing

    async refreshPriceData(): Promise<PriceInfoType> {
        if(this.pricingInfo==null) return null;
        const priceData = await this.wrapper.prices.isValidAmountReceive(this.getInAmount(), this.pricingInfo.satsBaseFee, this.pricingInfo.feePPM, this.data.getAmount(), this.data.getToken());
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

    getInToken(): Token {
        return {
            chain: "BTC",
            lightning: true
        }
    }

    getOutToken(): Token {
        return {
            chain: "SC",
            address: this.wrapper.contract.getNativeCurrencyAddress()
        };
    }

    isFinished(): boolean {
        return this.state===LnForGasSwapState.FINISHED || this.state===LnForGasSwapState.FAILED || this.state===LnForGasSwapState.EXPIRED;
    }

    isQuoteExpired(): boolean {
        return this.state===LnForGasSwapState.EXPIRED;
    }

    isFailed(): boolean {
        return this.state===LnForGasSwapState.FAILED;
    }

    isQuoteValid(): Promise<boolean> {
        return Promise.resolve(this.getTimeoutTime()>Date.now());
    }


    //////////////////////////////
    //// Amounts & fees

    protected getOutAmountWithoutFee(): BN {
        return this.getOutAmount().add(this.swapFee);
    }

    getOutAmount(): BN {
        return this.outputAmount;
    }

    getInAmountWithoutFee(): BN {
        return this.getInAmount().sub(this.swapFeeBtc);
    }

    getInAmount(): BN {
        const parsed = bolt11Decode(this.pr);
        return new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    getSwapFee(): Fee {
        return {
            amountInSrcToken: this.swapFeeBtc,
            amountInDstToken: this.swapFee
        };
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
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds: number = 5): Promise<void> {
        if(this.state!==LnForGasSwapState.PR_CREATED) throw new Error("Must be in PR_CREATED state!");

        await this._save();

        while(!abortSignal.aborted && this.state===LnForGasSwapState.PR_CREATED) {
            await this.checkInvoicePaid(true);
            if(this.state!==LnForGasSwapState.PR_CREATED) await timeoutPromise(checkIntervalSeconds*1000, abortSignal);
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
}