import {SwapType} from "./SwapType";
import {EventEmitter} from "events";
import * as BN from "bn.js";
import {Buffer} from "buffer";
import {ISwapWrapper, ISwapWrapperOptions} from "./ISwapWrapper";
import {SwapCommitStatus, SwapData, TokenAddress} from "crosslightning-base";
import {isPriceInfoType, PriceInfoType} from "../prices/abstract/ISwapPrice";
import {getLogger, LoggerType, timeoutPromise} from "../utils/Utils";

export type ISwapInit<T extends SwapData> = {
    pricingInfo: PriceInfoType,
    url: string,
    expiry: number,
    swapFee: BN,
    swapFeeBtc?: BN,
    feeRate: any,
    prefix?: string,
    timeout?: string,
    signature?: string,
    data?: T
};

export function isISwapInit<T extends SwapData>(obj: any): obj is ISwapInit<T> {
    return typeof obj === 'object' &&
        obj != null &&
        isPriceInfoType(obj.pricingInfo) &&
        typeof obj.url === 'string' &&
        typeof obj.expiry === 'number' &&
        BN.isBN(obj.swapFee) &&
        (obj.swapFeeBtc == null || BN.isBN(obj.swapFeeBtc)) &&
        obj.feeRate != null &&
        (obj.prefix == null || typeof obj.prefix === 'string') &&
        (obj.timeout == null || typeof obj.timeout === 'string') &&
        (obj.signature == null || typeof obj.signature === 'string') &&
        (obj.data == null || typeof obj.data === 'object');
}

export type Fee = {
    amountInSrcToken: BN;
    amountInDstToken: BN;
}

export type BtcToken<L = boolean> = {
    chain: "BTC",
    lightning: L
};

export type SCToken<T = TokenAddress> = {
    chain: "SC",
    address: T
}

export type Token = BtcToken | SCToken;

export abstract class ISwap<
    T extends SwapData = SwapData,
    S extends number = number,
    TXType = any
> {
    protected logger: LoggerType;
    protected readonly abstract TYPE: SwapType;
    protected readonly wrapper: ISwapWrapper<T, ISwap<T, S, TXType>, ISwapWrapperOptions, TXType>;
    expiry?: number;
    readonly url: string;

    state: S;

    pricingInfo: PriceInfoType;

    data: T;
    prefix?: string;
    timeout?: string;
    signature?: string;
    feeRate?: any;

    protected swapFee: BN;
    protected swapFeeBtc?: BN;

    /**
     * Transaction IDs for the swap on the smart chain side
     */
    commitTxId: string;
    refundTxId?: string;
    claimTxId?: string;

    /**
     * Event emitter emitting "swapState" event when swap's state changes
     */
    events: EventEmitter<{
        swapState: [ISwap<T>]
    }> = new EventEmitter<{swapState: [ISwap<T>]}>();

    protected constructor(wrapper: ISwapWrapper<T, ISwap<T, S>>, obj: any);
    protected constructor(wrapper: ISwapWrapper<T, ISwap<T, S>>, swapInit: ISwapInit<T>);
    protected constructor(
        wrapper: ISwapWrapper<T, ISwap<T, S>>,
        swapInitOrObj: ISwapInit<T> | any,
    ) {
        this.wrapper = wrapper;
        if(isISwapInit(swapInitOrObj)) {
            Object.assign(this, swapInitOrObj);
        } else {
            this.expiry = swapInitOrObj.expiry;
            this.url = swapInitOrObj.url;

            this.state = swapInitOrObj.state;

            this.pricingInfo = {
                isValid: swapInitOrObj._isValid,
                differencePPM: swapInitOrObj._differencePPM==null ? null : new BN(swapInitOrObj._differencePPM),
                satsBaseFee: swapInitOrObj._satsBaseFee==null ? null : new BN(swapInitOrObj._satsBaseFee),
                feePPM: swapInitOrObj._feePPM==null ? null : new BN(swapInitOrObj._feePPM),
                realPriceUSatPerToken: swapInitOrObj._realPriceUSatPerToken==null ? null : new BN(swapInitOrObj._realPriceUSatPerToken),
                swapPriceUSatPerToken: swapInitOrObj._swapPriceUSatPerToken==null ? null : new BN(swapInitOrObj._swapPriceUSatPerToken),
            }

            this.data = swapInitOrObj.data!=null ? new wrapper.swapDataDeserializer(swapInitOrObj.data) : null;
            this.swapFee = swapInitOrObj.swapFee==null ? null : new BN(swapInitOrObj.swapFee);
            this.swapFeeBtc = swapInitOrObj.swapFeeBtc==null ? null : new BN(swapInitOrObj.swapFeeBtc);
            this.prefix = swapInitOrObj.prefix;
            this.timeout = swapInitOrObj.timeout;
            this.signature = swapInitOrObj.signature;
            this.feeRate = swapInitOrObj.feeRate;

            this.commitTxId = swapInitOrObj.commitTxId;
            this.claimTxId = swapInitOrObj.claimTxId;
            this.refundTxId = swapInitOrObj.refundTxId;
        }
        this.logger = getLogger(this.constructor.name+"("+this.getPaymentHashString()+"): ");
    }

    /**
     * Periodically checks the chain to see whether the swap is committed
     *
     * @param abortSignal
     * @param interval How often to check (in seconds), default to 5s
     * @protected
     */
    protected async watchdogWaitTillCommited(abortSignal?: AbortSignal, interval: number = 5): Promise<void> {
        let status: SwapCommitStatus = SwapCommitStatus.NOT_COMMITED;
        while(status===SwapCommitStatus.NOT_COMMITED) {
            await timeoutPromise(interval*1000, abortSignal);
            try {
                status = await this.wrapper.contract.getCommitStatus(this.data);
            } catch (e) {
                this.logger.error("watchdogWaitTillCommited(): Error when fetching commit status: ", e);
            }
        }
        if(abortSignal!=null) abortSignal.throwIfAborted();
    }

    /**
     * Periodically checks the chain to see whether the swap was finished (claimed or refunded)
     *
     * @param abortSignal
     * @param interval How often to check (in seconds), default to 5s
     * @protected
     */
    protected async watchdogWaitTillResult(abortSignal?: AbortSignal, interval: number = 5): Promise<
        SwapCommitStatus.PAID | SwapCommitStatus.EXPIRED | SwapCommitStatus.NOT_COMMITED
    > {
        let status: SwapCommitStatus = SwapCommitStatus.COMMITED;
        while(status===SwapCommitStatus.COMMITED || status===SwapCommitStatus.REFUNDABLE) {
            await timeoutPromise(interval*1000, abortSignal);
            try {
                status = await this.wrapper.contract.getCommitStatus(this.data);
            } catch (e) {
                this.logger.error("watchdogWaitTillResult(): Error when fetching commit status: ", e);
            }
        }
        if(abortSignal!=null) abortSignal.throwIfAborted();
        return status;
    }

    /**
     * Waits till the swap reaches a specific state
     *
     * @param targetState The state to wait for
     * @param type Whether to wait for the state exactly or also to a state with a higher number
     * @param abortSignal
     * @protected
     */
    protected waitTillState(targetState: S, type: "eq" | "gte" | "neq" = "eq", abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            let listener;
            listener = (swap) => {
                if(type==="eq" ? swap.state===targetState : type==="gte" ? swap.state>=targetState : swap.state!=targetState) {
                    resolve();
                    this.events.removeListener("swapState", listener);
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
                this.events.removeListener("swapState", listener);
                reject(abortSignal.reason);
            });
        });
    }


    //////////////////////////////
    //// Pricing

    /**
     * Checks if the pricing for the swap is valid, according to max allowed price difference set in the ISwapPrice
     */
    hasValidPrice(): boolean {
        return this.pricingInfo==null ? null : this.pricingInfo.isValid;
    }

    /**
     * Returns the price difference between offered price and current market price in PPM (parts per million)
     */
    getPriceDifferencePPM(): BN {
        return this.pricingInfo==null ? null :this.pricingInfo.differencePPM;
    }

    /**
     * Returns the price difference between offered price and current market price as a decimal number
     */
    getPriceDifferencePct(): number {
        return this.pricingInfo==null ? null : this.pricingInfo.differencePPM==null ? null : this.pricingInfo.differencePPM.toNumber()/1000000;
    }

    /**
     * Re-fetches & revalidates the price data
     */
    abstract refreshPriceData(): Promise<PriceInfoType>;

    /**
     * Returns the offered swap quote price
     */
    abstract getSwapPrice(): number;

    /**
     * Returns the real current market price fetched from reputable exchanges
     */
    abstract getMarketPrice(): number;

    /**
     * Returns the real swap fee percentage as PPM (parts per million)
     */
    abstract getRealSwapFeePercentagePPM(): BN;

    //////////////////////////////
    //// Getters & utils

    getPaymentHashString(): string {
        const paymentHash = this.getPaymentHash();
        if(paymentHash==null) return null;
        return paymentHash.toString("hex");
    }

    /**
     * Returns payment hash identifier of the swap
     */
    getPaymentHash(): Buffer {
        if(this.data==null) return null;
        return Buffer.from(this.data.getHash(), "hex");
    }

    /**
     * Returns quote expiry in UNIX millis
     */
    getExpiry(): number {
        return this.expiry;
    }

    /**
     * Returns the input token for the swap
     */
    abstract getInToken(): Token;

    /**
     * Returns the output token for the swap
     */
    abstract getOutToken(): Token;

    /**
     * Returns the type of the swap
     */
    getType(): SwapType {
        return this.TYPE;
    }

    /**
     * Returns the current state of the swap
     */
    getState(): S {
        return this.state;
    }

    /**
     * Returns whether the swap is finished and in its terminal state (this can mean successful, refunded or failed)
     */
    abstract isFinished(): boolean;

    /**
     * Checks whether the swap's quote has expired and cannot be committed anymore, we can remove such swap
     */
    abstract isQuoteExpired(): boolean;

    /**
     * Returns whether the swap finished successful
     */
    abstract isSuccessful(): boolean;

    /**
     * Returns whether the swap failed (e.g. was refunded)
     */
    abstract isFailed(): boolean;

    /**
     * Checks if the swap's quote is still valid
     */
    abstract isQuoteValid(): Promise<boolean>;

    //////////////////////////////
    //// Amounts & fees

    /**
     * Get the estimated smart chain fee of the commit transaction
     */
    getCommitFee(): Promise<BN> {
        return this.wrapper.contract.getCommitFee(this.data);
    }

    /**
     * Returns output amount of the swap, user receives this much
     */
    abstract getOutAmount(): BN;

    /**
     * Returns input amount of the swap, user needs to pay this much
     */
    abstract getInAmount(): BN;

    /**
     * Returns input amount if the swap without the fees (swap fee, network fee)
     */
    abstract getInAmountWithoutFee(): BN;

    /**
     * Returns total fee for the swap, the fee is represented in source currency & destination currency, but is
     *  paid only once
     */
    getFee(): Fee {
        return this.getSwapFee();
    }

    /**
     * Returns swap fee for the swap, the fee is represented in source currency & destination currency, but is
     *  paid only once
     */
    abstract getSwapFee(): Fee;


    //////////////////////////////
    //// Storage

    serialize(): any {
        if(this.pricingInfo==null) return {};
        return {
            _isValid: this.pricingInfo.isValid,
            _differencePPM: this.pricingInfo.differencePPM==null ? null :this.pricingInfo.differencePPM.toString(10),
            _satsBaseFee: this.pricingInfo.satsBaseFee==null ? null :this.pricingInfo.satsBaseFee.toString(10),
            _feePPM: this.pricingInfo.feePPM==null ? null :this.pricingInfo.feePPM.toString(10),
            _realPriceUSatPerToken: this.pricingInfo.realPriceUSatPerToken==null ? null :this.pricingInfo.realPriceUSatPerToken.toString(10),
            _swapPriceUSatPerToken: this.pricingInfo.swapPriceUSatPerToken==null ? null :this.pricingInfo.swapPriceUSatPerToken.toString(10),
            state: this.state,
            url: this.url,
            data: this.data!=null ? this.data.serialize() : null,
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            swapFeeBtc: this.swapFeeBtc==null ? null : this.swapFeeBtc.toString(10),
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            feeRate: this.feeRate==null ? null : this.feeRate.toString(),
            commitTxId: this.commitTxId,
            claimTxId: this.claimTxId,
            refundTxId: this.refundTxId,
            expiry: this.expiry
        }
    }

    _save(): Promise<void> {
        this.wrapper.swapData.set(this.getPaymentHashString(), this);
        return this.wrapper.storage.saveSwapData(this);
    }

    async _saveAndEmit(state?: S): Promise<void> {
        if(state!=null) this.state = state;
        await this._save();
        this._emitEvent();
    }


    //////////////////////////////
    //// Events

    _emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

}
