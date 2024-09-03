import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import {ToBTCLNSwap} from "./ToBTCLNSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {AmountData} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {UserError} from "../../../errors/UserError";
import {
    ChainEvents, ChainSwapType, IntermediaryReputationType,
    IStorageManager,
    SwapCommitStatus,
    SwapContract,
    SwapData,
    TokenAddress
} from "crosslightning-base";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {ISwapWrapperOptions} from "../../ISwapWrapper";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {EventEmitter} from "events";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController} from "../../../utils/Utils";
import {IntermediaryAPI, ToBTCLNResponseType} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";
import {LNURL, LNURLPayParamsWithUrl} from "../../../utils/LNURL";

export type ToBTCLNOptions = {
    expirySeconds: number,
    maxFee?: BN | Promise<BN>,
    expiryTimestamp?: BN,
    maxRoutingPPM?: BN,
    maxRoutingBaseFee?: BN
}

export type ToBTCLNWrapperOptions = ISwapWrapperOptions & {
    lightningBaseFee?: number,
    lightningFeePPM?: number
};

export class ToBTCLNWrapper<T extends SwapData> extends IToBTCWrapper<T, ToBTCLNSwap<T>, ToBTCLNWrapperOptions> {

    protected readonly swapDeserializer = ToBTCLNSwap;

    private calculateFeeForAmount(amount: BN, overrideBaseFee?: BN, overrideFeePPM?: BN) : BN {
        return new BN(overrideBaseFee || this.options.lightningBaseFee).add(amount.mul(new BN(overrideFeePPM || this.options.lightningFeePPM)).div(new BN(1000000)));
    }

    constructor(
        storage: IStorageManager<ToBTCLNSwap<T>>,
        contract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        prices: ISwapPrice,
        swapDataDeserializer: new (data: any) => T,
        options?: ToBTCLNWrapperOptions,
        events?: EventEmitter<{swapState: [ToBTCLNSwap<T>]}>
    ) {
        if(options==null) options = {};
        options.lightningBaseFee = options.lightningBaseFee || 10;
        options.lightningFeePPM = options.lightningFeePPM || 2000;
        super(storage, contract, chainEvents, prices, swapDataDeserializer, options, events);
    }

    private preFetchPayStatus(parsedPr: PaymentRequestObject & {tagsObject: TagsObject}, abortController: AbortController): Promise<void> {
        return tryWithRetries(
            () => this.contract.getPaymentHashStatus(parsedPr.tagsObject.payment_hash),
            null, null, abortController.signal
        ).then(payStatus => {
            if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
                throw new UserError("Invoice already being paid for or paid");
            }
        }).catch(e => {
            abortController.abort(e);
        })
    }

    private async verifyReturnedData(
        resp: ToBTCLNResponseType,
        parsedPr: PaymentRequestObject & {tagsObject: TagsObject},
        token: TokenAddress,
        lp: Intermediary,
        options: ToBTCLNOptions,
        data: T,
        requiredTotal?: BN
    ): Promise<void> {
        if(resp.routingFeeSats.gt(await options.maxFee)) throw new IntermediaryError("Invalid max fee sats returned");

        if(requiredTotal!=null && !resp.total.eq(requiredTotal))
            throw new IntermediaryError("Invalid data returned - total amount");

        if(
            !data.getAmount().eq(resp.total) ||
            data.getHash()!==parsedPr.tagsObject.payment_hash ||
            !data.getEscrowNonce().eq(new BN(0)) ||
            data.getConfirmations()!==0 ||
            !data.getExpiry().eq(options.expiryTimestamp) ||
            data.getType()!==ChainSwapType.HTLC ||
            !data.isPayIn() ||
            !data.isToken(token) ||
            data.getClaimer()!==lp.address
        ) {
            throw new IntermediaryError("Invalid data returned");
        }
    }

    private async getIntermediaryQuote(
        amountData: Omit<AmountData, "amount">,
        lp: Intermediary,
        pr: string,
        parsedPr: PaymentRequestObject & {tagsObject: TagsObject},
        options: ToBTCLNOptions,
        preFetches: {
            feeRatePromise: Promise<any>,
            pricePreFetchPromise: Promise<BN>,
            payStatusPromise: Promise<void>,
            reputationPromise?: Promise<IntermediaryReputationType>
        },
        abort: AbortSignal | AbortController,
        additionalParams: Record<string, any>,
    ) {
        const abortController = abort instanceof AbortController ? abort : extendAbortController(abort);
        preFetches.reputationPromise ??= this.preFetchIntermediaryReputation(amountData, lp, abortController);

        try {
            const {signDataPromise, resp} = await tryWithRetries(async() => {
                const {signDataPrefetch, response} = IntermediaryAPI.initToBTCLN(lp.url, {
                    offerer: this.contract.getAddress(),
                    pr,
                    maxFee: await options.maxFee,
                    expiryTimestamp: options.expiryTimestamp,
                    token: amountData.token,
                    feeRate: preFetches.feeRatePromise,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal);

                return {
                    signDataPromise: this.preFetchSignData(signDataPrefetch),
                    resp: await response
                };
            }, null, e => e instanceof RequestError, abortController.signal);

            const amountOut: BN = new BN(parsedPr.millisatoshis).add(new BN(999)).div(new BN(1000));
            const totalFee: BN = resp.swapFee.add(resp.maxFee);
            const data: T = new this.swapDataDeserializer(resp.data);
            this.contract.setUsAsOfferer(data);

            await this.verifyReturnedData(resp, parsedPr, amountData.token, lp, options, data);

            const [pricingInfo, signatureExpiry, reputation] = await Promise.all([
                this.verifyReturnedPrice(
                    lp.services[SwapType.TO_BTCLN], true, amountOut, data.getAmount(),
                    amountData.token, {swapFee: resp.swapFee, networkFee: resp.maxFee, totalFee},
                    preFetches.pricePreFetchPromise, abortController.signal
                ),
                this.verifyReturnedSignature(
                    data, resp, preFetches.feeRatePromise, signDataPromise, abortController.signal
                ),
                preFetches.reputationPromise,
                preFetches.payStatusPromise
            ]);
            abortController.signal.throwIfAborted();

            lp.reputation[amountData.token.toString()] = reputation;

            return new ToBTCLNSwap<T>(this, {
                pricingInfo,
                url: lp.url,
                expiry: signatureExpiry,
                swapFee: resp.swapFee,
                feeRate: await preFetches.feeRatePromise,
                prefix: resp.prefix,
                timeout: resp.timeout,
                signature: resp.signature,
                data,
                networkFee: resp.maxFee,
                networkFeeBtc: resp.routingFeeSats,
                confidence: resp.confidence,
                pr
            });
        } catch (e) {
            abortController.abort(e);
            throw e;
        }
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param bolt11PayRequest  BOLT11 payment request (bitcoin lightning invoice) you wish to pay
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     * @param preFetches
     */
    create(
        bolt11PayRequest: string,
        amountData: Omit<AmountData, "amount">,
        lps: Intermediary[],
        options: ToBTCLNOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal,
        preFetches?: {
            feeRatePromise: Promise<any>,
            pricePreFetchPromise: Promise<BN>,
            payStatusPromise: Promise<void>
        },
    ): {
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[] {
        options.expiryTimestamp ??= new BN(Math.floor(Date.now()/1000)+options.expirySeconds);

        const parsedPr = bolt11Decode(bolt11PayRequest);
        if(parsedPr.millisatoshis==null) throw new UserError("Must be an invoice with amount");
        const amountOut: BN = new BN(parsedPr.millisatoshis).add(new BN(999)).div(new BN(1000));
        options.maxFee ??= this.calculateFeeForAmount(amountOut, options.maxRoutingBaseFee, options.maxRoutingPPM);

        const _abortController = extendAbortController(abortSignal);
        if(preFetches==null) preFetches = {
            pricePreFetchPromise: this.preFetchPrice(amountData, _abortController.signal),
            payStatusPromise: this.preFetchPayStatus(parsedPr, _abortController),
            feeRatePromise: this.preFetchFeeRate(amountData, parsedPr.tagsObject.payment_hash, _abortController)
        };

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: this.getIntermediaryQuote(amountData, lp, bolt11PayRequest, parsedPr, options, preFetches, _abortController.signal, additionalParams)
            }
        });
    }

    private async getLNURLPay(lnurl: string | LNURLPayParamsWithUrl, abortSignal: AbortSignal): Promise<LNURLPayParamsWithUrl> {
        if(typeof(lnurl)!=="string") return lnurl;

        const res = await LNURL.getLNURL(lnurl, true, this.options.getRequestTimeout, abortSignal);
        if(res==null) throw new UserError("Invalid LNURL");
        if(res.tag!=="payRequest") throw new UserError("Not a LNURL-pay");
        return res;
    }

    private async getIntermediaryQuoteExactIn(
        amountData: AmountData,
        payRequest: LNURLPayParamsWithUrl,
        lp: Intermediary,
        dummyPr: string,
        options: ToBTCLNOptions & {comment?: string},
        preFetches: {
            feeRatePromise: Promise<any>,
            pricePreFetchPromise: Promise<BN>
        },
        abortSignal: AbortSignal,
        additionalParams: Record<string, any>,
    ) {
        const abortController = extendAbortController(abortSignal);
        const reputationPromise: Promise<IntermediaryReputationType> = this.preFetchIntermediaryReputation(amountData, lp, abortController);

        try {
            const {signDataPromise, prepareResp} = await tryWithRetries(async() => {
                const {signDataPrefetch, response} = IntermediaryAPI.prepareToBTCLNExactIn(lp.url, {
                    token: amountData.token,
                    offerer: this.contract.getAddress(),
                    pr: dummyPr,
                    amount: amountData.amount,
                    maxFee: await options.maxFee,
                    expiryTimestamp: options.expiryTimestamp,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal);

                return {
                    signDataPromise: this.preFetchSignData(signDataPrefetch),
                    prepareResp: await response
                };
            }, null, e => e instanceof RequestError, abortController.signal);

            if(prepareResp.amount.isZero() || prepareResp.amount.isNeg())
                throw new IntermediaryError("Invalid amount returned (zero or negative)");

            const min = new BN(payRequest.minSendable).div(new BN(1000));
            const max = new BN(payRequest.maxSendable).div(new BN(1000));

            if(prepareResp.amount.lt(min)) throw new UserError("Amount less than minimum");
            if(prepareResp.amount.gt(max)) throw new UserError("Amount more than maximum");

            const {
                invoice,
                parsedInvoice,
                successAction
            } = await LNURL.useLNURLPay(payRequest, prepareResp.amount, options.comment, this.options.getRequestTimeout, abortController.signal);

            const payStatusPromise = this.preFetchPayStatus(parsedInvoice, abortController);

            const resp = await tryWithRetries(
                () => IntermediaryAPI.initToBTCLNExactIn(lp.url, {
                    pr: invoice,
                    reqId: resp.reqId,
                    feeRate: preFetches.feeRatePromise,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal),
                null, e => e instanceof RequestError, abortController.signal
            );

            const totalFee: BN = resp.swapFee.add(resp.maxFee);
            const data: T = new this.swapDataDeserializer(resp.data);
            this.contract.setUsAsOfferer(data);

            await this.verifyReturnedData(resp, parsedInvoice, amountData.token, lp, options, data, amountData.amount);

            const [pricingInfo, signatureExpiry, reputation] = await Promise.all([
                this.verifyReturnedPrice(
                    lp.services[SwapType.TO_BTCLN], true, prepareResp.amount, data.getAmount(),
                    amountData.token, {swapFee: resp.swapFee, networkFee: resp.maxFee, totalFee},
                    preFetches.pricePreFetchPromise, abortSignal
                ),
                this.verifyReturnedSignature(
                    data, resp, preFetches.feeRatePromise, signDataPromise, abortController.signal
                ),
                reputationPromise,
                payStatusPromise
            ]);
            abortController.signal.throwIfAborted();

            lp.reputation[amountData.token.toString()] = reputation;

            return new ToBTCLNSwap<T>(this, {
                pricingInfo,
                url: lp.url,
                expiry: signatureExpiry,
                swapFee: resp.swapFee,
                feeRate: await preFetches.feeRatePromise,
                prefix: resp.prefix,
                timeout: resp.timeout,
                signature: resp.signature,
                data,
                networkFee: resp.maxFee,
                networkFeeBtc: resp.routingFeeSats,
                confidence: resp.confidence,
                pr: invoice,
                lnurl: payRequest.url,
                successAction
            });
        } catch (e) {
            abortController.abort(e);
            throw e;
        }
    }

    async createViaLNURL(
        lnurl: string | LNURLPayParamsWithUrl,
        amountData: AmountData,
        lps: Intermediary[],
        options: ToBTCLNOptions & {comment: string},
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): Promise<{
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[]> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");
        options.expiryTimestamp ??= new BN(Math.floor(Date.now()/1000)+options.expirySeconds);

        const _abortController = extendAbortController(abortSignal);
        const pricePreFetchPromise: Promise<BN> = this.preFetchPrice(amountData, _abortController.signal);
        const feeRatePromise: Promise<any> = this.preFetchFeeRate(amountData, null, _abortController);

        options.maxRoutingPPM ??= new BN(this.options.lightningFeePPM);
        options.maxRoutingBaseFee ??= new BN(this.options.lightningBaseFee);
        if(amountData.exactIn) {
            options.maxFee ??= pricePreFetchPromise
                .then(
                    val => this.prices.getFromBtcSwapAmount(options.maxRoutingBaseFee, amountData.token, abortSignal, val)
                )
                .then(
                    _maxBaseFee => this.calculateFeeForAmount(amountData.amount, _maxBaseFee, options.maxRoutingPPM)
                )
        } else {
            options.maxFee = this.calculateFeeForAmount(amountData.amount, options.maxRoutingBaseFee, options.maxRoutingPPM)
        }

        try {
            let payRequest: LNURLPayParamsWithUrl = await this.getLNURLPay(lnurl, _abortController.signal);

            if(
                options.comment!=null &&
                (payRequest.commentAllowed==null || options.comment.length>payRequest.commentAllowed)
            ) throw new UserError("Comment not allowed or too long");

            if(amountData.exactIn) {
                const {invoice: dummyInvoice} = await LNURL.useLNURLPay(
                    payRequest, new BN(payRequest.minSendable).div(new BN(1000)), null,
                    this.options.getRequestTimeout, _abortController.signal
                );

                return lps.map(lp => {
                    return {
                        quote: this.getIntermediaryQuoteExactIn(amountData, payRequest, lp, dummyInvoice, options, {
                            pricePreFetchPromise,
                            feeRatePromise
                        }, _abortController.signal, additionalParams),
                        intermediary: lp
                    }
                })
            } else {
                const min = new BN(payRequest.minSendable).div(new BN(1000));
                const max = new BN(payRequest.maxSendable).div(new BN(1000));

                if(amountData.amount.lt(min)) throw new UserError("Amount less than minimum");
                if(amountData.amount.gt(max)) throw new UserError("Amount more than maximum");

                const {
                    invoice,
                    parsedInvoice,
                    successAction
                } = await LNURL.useLNURLPay(payRequest, amountData.amount, options.comment, this.options.getRequestTimeout, _abortController.signal);

                const payStatusPromise = this.preFetchPayStatus(parsedInvoice, _abortController);

                return this.create(invoice, amountData, lps, options, additionalParams, _abortController.signal, {
                    feeRatePromise,
                    pricePreFetchPromise,
                    payStatusPromise,
                }).map(data => {
                    return {
                        quote: data.quote.then(quote => {
                            quote.lnurl = payRequest.url;
                            quote.successAction = successAction;
                            return quote;
                        }),
                        intermediary: data.intermediary
                    }
                });
            }
        } catch (e) {
            _abortController.abort(e);
            throw e;
        }
    }
}
