import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import {ToBTCLNSwap} from "./ToBTCLNSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import * as BN from "bn.js";
import {UserError} from "../../../errors/UserError";
import {
    ChainSwapType, ChainType,
    IStorageManager,
    SwapCommitStatus
} from "crosslightning-base";
import {Intermediary, SingleChainReputationType} from "../../../intermediaries/Intermediary";
import {AmountData, ISwapWrapperOptions, WrapperCtorTokens} from "../../ISwapWrapper";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {EventEmitter} from "events";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController, tryWithRetries} from "../../../utils/Utils";
import {IntermediaryAPI, ToBTCLNResponseType} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";
import {LNURL, LNURLPayParamsWithUrl} from "../../../utils/LNURL";
import {IToBTCSwapInit} from "../IToBTCSwap";

export type AbortControllerTyped<T> = AbortController & {
    abort: (reason: T) => void,
    signal: AbortSignal & {
        reason: T
    }
};

export type ToBTCLNOptions = {
    expirySeconds?: number,
    maxFee?: BN | Promise<BN>,
    expiryTimestamp?: BN,
    maxRoutingPPM?: BN,
    maxRoutingBaseFee?: BN
}

export type ToBTCLNWrapperOptions = ISwapWrapperOptions & {
    lightningBaseFee?: number,
    lightningFeePPM?: number,
    paymentTimeoutSeconds?: number
};

export class ToBTCLNWrapper<T extends ChainType> extends IToBTCWrapper<T, ToBTCLNSwap<T>, ToBTCLNWrapperOptions> {

    protected readonly swapDeserializer = ToBTCLNSwap;

    constructor(
        chainIdentifier: string,
        storage: IStorageManager<ToBTCLNSwap<T>>,
        contract: T["Contract"],
        chainEvents: T["Events"],
        prices: ISwapPrice,
        tokens: WrapperCtorTokens,
        swapDataDeserializer: new (data: any) => T["Data"],
        options?: ToBTCLNWrapperOptions,
        events?: EventEmitter
    ) {
        if(options==null) options = {};
        options.paymentTimeoutSeconds ??= 4*24*60*60;
        options.lightningBaseFee ??= 10;
        options.lightningFeePPM ??= 2000;
        super(chainIdentifier, storage, contract, chainEvents, prices, tokens, swapDataDeserializer, options, events);
    }

    /**
     * Calculates maximum lightning network routing fee based on amount
     *
     * @param amount BTC amount of the swap in satoshis
     * @param overrideBaseFee Override wrapper's default base fee
     * @param overrideFeePPM Override wrapper's default PPM
     * @private
     * @returns Maximum lightning routing fee in sats
     */
    private calculateFeeForAmount(amount: BN, overrideBaseFee?: BN, overrideFeePPM?: BN) : BN {
        return new BN(overrideBaseFee || this.options.lightningBaseFee)
            .add(amount.mul(new BN(overrideFeePPM || this.options.lightningFeePPM)).div(new BN(1000000)));
    }

    /**
     * Pre-fetches & checks status of the specific lightning BOLT11 invoice
     *
     * @param parsedPr Parsed bolt11 invoice
     * @param abortController Aborts in case the invoice is/was already paid
     * @private
     */
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
        });
    }

    /**
     * Verifies returned LP data
     *
     * @param resp Response as returned by the LP
     * @param parsedPr Parsed bolt11 lightning invoice
     * @param token Smart chain token to be used in the swap
     * @param lp
     * @param options Swap options as passed to the swap create function
     * @param data Parsed swap data returned by the LP
     * @param requiredTotal Required total to be paid on the input (for exactIn swaps)
     * @private
     * @throws {IntermediaryError} In case the response is not valid
     */
    private async verifyReturnedData(
        resp: ToBTCLNResponseType,
        parsedPr: PaymentRequestObject & {tagsObject: TagsObject},
        token: string,
        lp: Intermediary,
        options: ToBTCLNOptions,
        data: T["Data"],
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
            data.getClaimer()!==lp.getAddress(this.chainIdentifier)
        ) {
            throw new IntermediaryError("Invalid data returned");
        }
    }

    /**
     * Returns the quote/swap from a given intermediary
     *
     * @param signer Smartchain signer initiating the swap
     * @param amountData
     * @param lp Intermediary
     * @param pr bolt11 lightning network invoice
     * @param parsedPr Parsed bolt11 lightning network invoice
     * @param options Options as passed to the swap create function
     * @param preFetches
     * @param abort Abort signal or controller, if AbortController is passed it is used as-is, when AbortSignal is passed
     *  it is extended with extendAbortController and then used
     * @param additionalParams Additional params that should be sent to the LP
     * @private
     */
    private async getIntermediaryQuote(
        signer: string,
        amountData: Omit<AmountData, "amount">,
        lp: Intermediary,
        pr: string,
        parsedPr: PaymentRequestObject & {tagsObject: TagsObject},
        options: ToBTCLNOptions,
        preFetches: {
            feeRatePromise: Promise<any>,
            pricePreFetchPromise: Promise<BN>,
            payStatusPromise: Promise<void>,
            reputationPromise?: Promise<SingleChainReputationType>
        },
        abort: AbortSignal | AbortController,
        additionalParams: Record<string, any>,
    ) {
        const abortController = abort instanceof AbortController ? abort : extendAbortController(abort);
        preFetches.reputationPromise ??= this.preFetchIntermediaryReputation(amountData, lp, abortController);

        try {
            const {signDataPromise, resp} = await tryWithRetries(async(retryCount: number) => {
                const {signDataPrefetch, response} = IntermediaryAPI.initToBTCLN(this.chainIdentifier, lp.url, {
                    offerer: signer,
                    pr,
                    maxFee: await options.maxFee,
                    expiryTimestamp: options.expiryTimestamp,
                    token: amountData.token,
                    feeRate: preFetches.feeRatePromise,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal, retryCount>0 ? false : null);

                return {
                    signDataPromise: this.preFetchSignData(signDataPrefetch),
                    resp: await response
                };
            }, null, e => e instanceof RequestError, abortController.signal);

            const amountOut: BN = new BN(parsedPr.millisatoshis).add(new BN(999)).div(new BN(1000));
            const totalFee: BN = resp.swapFee.add(resp.maxFee);
            const data: T["Data"] = new this.swapDataDeserializer(resp.data);
            data.setOfferer(signer);

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

            const quote = new ToBTCLNSwap<T>(this, {
                pricingInfo,
                url: lp.url,
                expiry: signatureExpiry,
                swapFee: resp.swapFee,
                feeRate: await preFetches.feeRatePromise,
                signatureData: resp,
                data,
                networkFee: resp.maxFee,
                networkFeeBtc: resp.routingFeeSats,
                confidence: resp.confidence,
                pr,
                exactIn: false
            } as IToBTCSwapInit<T["Data"]>);
            await quote._save();
            return quote;
        } catch (e) {
            abortController.abort(e);
            throw e;
        }
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param signer                Smartchain signer's address initiating the swap
     * @param bolt11PayRequest      BOLT11 payment request (bitcoin lightning invoice) you wish to pay
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     * @param preFetches            Existing pre-fetches for the swap (only used internally for LNURL swaps)
     */
    create(
        signer: string,
        bolt11PayRequest: string,
        amountData: Omit<AmountData, "amount">,
        lps: Intermediary[],
        options?: ToBTCLNOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal,
        preFetches?: {
            feeRatePromise: Promise<any>,
            pricePreFetchPromise: Promise<BN>,
            payStatusPromise: Promise<void>
        }
    ): {
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[] {
        options ??= {};
        options.expirySeconds ??= this.options.paymentTimeoutSeconds;
        options.expiryTimestamp ??= new BN(Math.floor(Date.now()/1000)+options.expirySeconds);

        const parsedPr = bolt11Decode(bolt11PayRequest);
        if(parsedPr.millisatoshis==null) throw new UserError("Must be an invoice with amount");
        const amountOut: BN = new BN(parsedPr.millisatoshis).add(new BN(999)).div(new BN(1000));
        options.maxFee ??= this.calculateFeeForAmount(amountOut, options.maxRoutingBaseFee, options.maxRoutingPPM);

        const _abortController = extendAbortController(abortSignal);
        if(preFetches==null) preFetches = {
            pricePreFetchPromise: this.preFetchPrice(amountData, _abortController.signal),
            payStatusPromise: this.preFetchPayStatus(parsedPr, _abortController),
            feeRatePromise: this.preFetchFeeRate(signer, amountData, parsedPr.tagsObject.payment_hash, _abortController)
        };

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: this.getIntermediaryQuote(signer, amountData, lp, bolt11PayRequest, parsedPr, options, preFetches, _abortController.signal, additionalParams)
            }
        });
    }

    /**
     * Parses and fetches lnurl pay params from the specified lnurl
     *
     * @param lnurl LNURL to be parsed and fetched
     * @param abortSignal
     * @private
     * @throws {UserError} if the LNURL is invalid or if it's not a LNURL-pay
     */
    private async getLNURLPay(lnurl: string | LNURLPayParamsWithUrl, abortSignal: AbortSignal): Promise<LNURLPayParamsWithUrl> {
        if(typeof(lnurl)!=="string") return lnurl;

        const res = await LNURL.getLNURL(lnurl, true, this.options.getRequestTimeout, abortSignal);
        if(res==null) throw new UserError("Invalid LNURL");
        if(res.tag!=="payRequest") throw new UserError("Not a LNURL-pay");
        return res;
    }

    /**
     * Returns the quote/swap from the given LP
     *
     * @param signer Smartchain signer's address initiating the swap
     * @param amountData
     * @param payRequest Parsed LNURL-pay params
     * @param lp Intermediary
     * @param dummyPr Dummy minimum value bolt11 lightning invoice returned from the LNURL-pay
     * @param options Options as passed to the swap create function
     * @param preFetches
     * @param abortSignal
     * @param additionalParams Additional params to be sent to the intermediary
     * @private
     */
    private async getIntermediaryQuoteExactIn(
        signer: string,
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
        const reputationPromise: Promise<SingleChainReputationType> = this.preFetchIntermediaryReputation(amountData, lp, abortController);

        try {
            const {signDataPromise, prepareResp} = await tryWithRetries(async(retryCount: number) => {
                const {signDataPrefetch, response} = IntermediaryAPI.prepareToBTCLNExactIn(this.chainIdentifier, lp.url, {
                    token: amountData.token,
                    offerer: signer,
                    pr: dummyPr,
                    amount: amountData.amount,
                    maxFee: await options.maxFee,
                    expiryTimestamp: options.expiryTimestamp,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal, retryCount>0 ? false : null);

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
                (retryCount: number) => IntermediaryAPI.initToBTCLNExactIn(lp.url, {
                    pr: invoice,
                    reqId: prepareResp.reqId,
                    feeRate: preFetches.feeRatePromise,
                    additionalParams
                }, this.options.postRequestTimeout, abortController.signal, retryCount>0 ? false : null),
                null, RequestError, abortController.signal
            );

            const totalFee: BN = resp.swapFee.add(resp.maxFee);
            const data: T["Data"] = new this.swapDataDeserializer(resp.data);
            data.setOfferer(signer);

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

            const quote = new ToBTCLNSwap<T>(this, {
                pricingInfo,
                url: lp.url,
                expiry: signatureExpiry,
                swapFee: resp.swapFee,
                feeRate: await preFetches.feeRatePromise,
                signatureData: resp,
                data,
                networkFee: resp.maxFee,
                networkFeeBtc: resp.routingFeeSats,
                confidence: resp.confidence,
                pr: invoice,
                lnurl: payRequest.url,
                successAction,
                exactIn: true
            } as IToBTCSwapInit<T["Data"]>);
            await quote._save();
            return quote;
        } catch (e) {
            abortController.abort(e);
            throw e;
        }
    }

    /**
     * Returns a newly created swap, paying for 'lnurl' - a lightning LNURL-pay
     *
     * @param signer                Smartchain signer's address initiating the swap
     * @param lnurl                 LMURL-pay you wish to pay
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers/intermediaries) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the intermediary when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    async createViaLNURL(
        signer: string,
        lnurl: string | LNURLPayParamsWithUrl,
        amountData: AmountData,
        lps: Intermediary[],
        options: ToBTCLNOptions & {comment?: string},
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): Promise<{
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[]> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");
        options ??= {};
        options.expirySeconds ??= this.options.paymentTimeoutSeconds;
        options.expiryTimestamp ??= new BN(Math.floor(Date.now()/1000)+options.expirySeconds);

        const _abortController = extendAbortController(abortSignal);
        const pricePreFetchPromise: Promise<BN> = this.preFetchPrice(amountData, _abortController.signal);
        const feeRatePromise: Promise<any> = this.preFetchFeeRate(signer, amountData, null, _abortController);

        options.maxRoutingPPM ??= new BN(this.options.lightningFeePPM);
        options.maxRoutingBaseFee ??= new BN(this.options.lightningBaseFee);
        if(amountData.exactIn) {
            options.maxFee ??= pricePreFetchPromise
                .then(
                    val => this.prices.getFromBtcSwapAmount(this.chainIdentifier, options.maxRoutingBaseFee, amountData.token, abortSignal, val)
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
                        quote: this.getIntermediaryQuoteExactIn(signer, amountData, payRequest, lp, dummyInvoice, options, {
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

                return this.create(signer, invoice, amountData, lps, options, additionalParams, _abortController.signal, {
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
