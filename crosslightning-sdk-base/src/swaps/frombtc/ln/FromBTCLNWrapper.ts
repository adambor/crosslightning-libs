import {FromBTCLNSwap, FromBTCLNSwapInit, FromBTCLNSwapState} from "./FromBTCLNSwap";
import {IFromBTCWrapper} from "../IFromBTCWrapper";
import * as BN from "bn.js";
import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import {
    ChainSwapType,
    ChainType,
    ClaimEvent,
    InitializeEvent,
    IStorageManager,
    RefundEvent,
    SwapCommitStatus
} from "crosslightning-base";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {Buffer} from "buffer";
import {UserError} from "../../../errors/UserError";
import * as randomBytes from "randombytes";
import * as createHash from "create-hash";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController, tryWithRetries} from "../../../utils/Utils";
import {FromBTCLNResponseType, IntermediaryAPI} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";
import {LightningNetworkApi, LNNodeLiquidity} from "../../../btc/LightningNetworkApi";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {EventEmitter} from "events";
import {AmountData, ISwapWrapperOptions, WrapperCtorTokens} from "../../ISwapWrapper";
import {LNURL, LNURLWithdrawParamsWithUrl} from "../../../utils/LNURL";

export type FromBTCLNOptions = {
    descriptionHash?: Buffer
};

export class FromBTCLNWrapper<
    T extends ChainType
> extends IFromBTCWrapper<T, FromBTCLNSwap<T>> {
    protected readonly swapDeserializer = FromBTCLNSwap;

    protected readonly lnApi: LightningNetworkApi;

    /**
     * @param chainIdentifier
     * @param storage Storage interface for the current environment
     * @param contract Underlying contract handling the swaps
     * @param prices Swap pricing handler
     * @param chainEvents On-chain event listener
     * @param tokens
     * @param swapDataDeserializer Deserializer for SwapData
     * @param lnApi
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        chainIdentifier: string,
        storage: IStorageManager<FromBTCLNSwap<T>>,
        contract: T["Contract"],
        chainEvents: T["Events"],
        prices: ISwapPrice,
        tokens: WrapperCtorTokens,
        swapDataDeserializer: new (data: any) => T["Data"],
        lnApi: LightningNetworkApi,
        options: ISwapWrapperOptions,
        events?: EventEmitter
    ) {
        super(chainIdentifier, storage, contract, chainEvents, prices, tokens, swapDataDeserializer, options, events);
        this.lnApi = lnApi;
    }

    protected async checkPastSwap(swap: FromBTCLNSwap<T>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_CREATED || (swap.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED && swap.signatureData==null)) {
            if(swap.getTimeoutTime()<Date.now()) {
                swap.state = FromBTCLNSwapState.QUOTE_SOFT_EXPIRED;
            }

            const result = await swap.checkIntermediaryPaymentReceived(false);
            if(result!==null) return true;
        }

        if(swap.state===FromBTCLNSwapState.PR_PAID || (swap.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED && swap.signatureData!=null)) {
            //Check if it's already committed
            const status = await tryWithRetries(() => this.contract.getCommitStatus(swap.getInitiator(), swap.data));
            switch(status) {
                case SwapCommitStatus.COMMITED:
                    swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
                    return true;
                case SwapCommitStatus.EXPIRED:
                    swap.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                    return true;
                case SwapCommitStatus.PAID:
                    swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                    return true;
            }

            if(!await swap.isQuoteValid()) {
                swap.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                return true;
            }

            return false;
        }

        if(swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            //Check if it's already successfully paid
            const commitStatus = await tryWithRetries(() => this.contract.getCommitStatus(swap.getInitiator(), swap.data));
            if(commitStatus===SwapCommitStatus.PAID) {
                swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                return true;
            }

            if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                swap.state = FromBTCLNSwapState.FAILED;
                return true;
            }

            return false;
        }
    }

    protected tickSwap(swap: FromBTCLNSwap<T>): void {
        switch(swap.state) {
            case FromBTCLNSwapState.PR_CREATED:
                if(swap.getTimeoutTime()<Date.now()) swap._saveAndEmit(FromBTCLNSwapState.QUOTE_SOFT_EXPIRED);
                break;
            case FromBTCLNSwapState.PR_PAID:
                if(swap.expiry<Date.now()) swap._saveAndEmit(FromBTCLNSwapState.QUOTE_SOFT_EXPIRED);
                break;
            case FromBTCLNSwapState.CLAIM_COMMITED:
                if(this.contract.isExpired(swap.getInitiator(), swap.data)) swap._saveAndEmit(FromBTCLNSwapState.EXPIRED);
                break;
        }
    }

    protected async processEventInitialize(swap: FromBTCLNSwap<T>, event: InitializeEvent<T["Data"]>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED) {
            const swapData = await event.swapData();
            if(swap.data!=null && !swap.data.equals(swapData)) return false;
            if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.QUOTE_SOFT_EXPIRED) swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
            swap.data = swapData;
            return true;
        }
    }

    protected processEventClaim(swap: FromBTCLNSwap<T>, event: ClaimEvent<T["Data"]>): Promise<boolean> {
        if(swap.state!==FromBTCLNSwapState.FAILED) {
            swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected processEventRefund(swap: FromBTCLNSwap<T>, event: RefundEvent<T["Data"]>): Promise<boolean> {
        if(swap.state!==FromBTCLNSwapState.CLAIM_CLAIMED) {
            swap.state = FromBTCLNSwapState.FAILED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    /**
     * Generates a new 32-byte secret to be used as pre-image for lightning network invoice & HTLC swap\
     *
     * @private
     * @returns Hash pre-image & payment hash
     */
    private getSecretAndHash(): {secret: Buffer, paymentHash: Buffer} {
        const secret = randomBytes(32);
        const paymentHash = createHash("sha256").update(secret).digest();
        return {secret, paymentHash};
    }

    /**
     * Pre-fetches intermediary's LN node capacity, doesn't throw, instead returns null
     *
     * @param pubkeyPromise Promise that resolves when we receive "lnPublicKey" param from the intermediary thorugh
     *  streaming
     * @private
     * @returns LN Node liquidity
     */
    private preFetchLnCapacity(pubkeyPromise: Promise<string>): Promise<LNNodeLiquidity | null> {
        return pubkeyPromise.then(pubkey => {
            if(pubkey==null) return null;
            return this.lnApi.getLNNodeLiquidity(pubkey)
        }).catch(e => {
            this.logger.error("preFetchLnCapacity(): Error: ", e);
            return null;
        })
    }

    /**
     * Verifies response returned from intermediary
     *
     * @param resp Response as returned by the intermediary
     * @param amountData
     * @param lp Intermediary
     * @param options Options as passed to the swap creation function
     * @param decodedPr Decoded bolt11 lightning network invoice
     * @param amountIn Amount in sats that will be paid for the swap
     * @private
     * @throws {IntermediaryError} in case the response is invalid
     */
    private verifyReturnedData(
        resp: FromBTCLNResponseType,
        amountData: AmountData,
        lp: Intermediary,
        options: FromBTCLNOptions,
        decodedPr: PaymentRequestObject & {tagsObject: TagsObject},
        amountIn: BN
    ): void {
        if(lp.getAddress(this.chainIdentifier)!==resp.intermediaryKey) throw new IntermediaryError("Invalid intermediary address/pubkey");

        if(options.descriptionHash!=null && decodedPr.tagsObject.purpose_commit_hash!==options.descriptionHash.toString("hex"))
            throw new IntermediaryError("Invalid pr returned - description hash");

        if(!amountData.exactIn) {
            if(!resp.total.eq(amountData.amount)) throw new IntermediaryError("Invalid amount returned");
        } else {
            if(!amountIn.eq(amountData.amount)) throw new IntermediaryError("Invalid payment request returned, amount mismatch");
        }
    }

    /**
     * Verifies whether the intermediary's lightning node has enough inbound capacity to receive the LN payment
     *
     * @param lp Intermediary
     * @param decodedPr Decoded bolt11 lightning network invoice
     * @param amountIn Amount to be paid for the swap in sats
     * @param lnCapacityPrefetchPromise Pre-fetch for LN node capacity, preFetchLnCapacity()
     * @param abortSignal
     * @private
     * @throws {IntermediaryError} if the lightning network node doesn't have enough inbound liquidity
     * @throws {Error} if the lightning network node's inbound liquidity might be enough, but the swap would
     *  deplete more than half of the liquidity
     */
    private async verifyLnNodeCapacity(
        lp: Intermediary,
        decodedPr: PaymentRequestObject & {tagsObject: TagsObject},
        amountIn: BN,
        lnCapacityPrefetchPromise: Promise<LNNodeLiquidity | null>,
        abortSignal?: AbortSignal
    ): Promise<void> {
        let result: LNNodeLiquidity = await lnCapacityPrefetchPromise;
        if(result==null) result = await this.lnApi.getLNNodeLiquidity(decodedPr.payeeNodeKey);
        if(abortSignal!=null) abortSignal.throwIfAborted();

        if(result===null) throw new IntermediaryError("LP's lightning node not found in the lightning network graph!");

        lp.lnData = result

        if(decodedPr.payeeNodeKey!==result.publicKey) throw new IntermediaryError("Invalid pr returned - payee pubkey");
        if(result.capacity.lt(amountIn))
            throw new IntermediaryError("LP's lightning node doesn't have enough inbound capacity for the swap!");
        if(result.capacity.div(new BN(2)).lt(amountIn))
            throw new Error("LP's lightning node probably doesn't have enough inbound capacity for the swap!");
    }

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param signer                Smart chain signer's address intiating the swap
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     * @param preFetches
     */
    create(
        signer: string,
        amountData: AmountData,
        lps: Intermediary[],
        options: FromBTCLNOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal,
        preFetches?: {
            pricePrefetchPromise?: Promise<BN>,
            feeRatePromise?: Promise<any>
        }
    ): {
        quote: Promise<FromBTCLNSwap<T>>,
        intermediary: Intermediary
    }[] {
        if(options==null) options = {};
        if(preFetches==null) preFetches = {};

        if(options.descriptionHash!=null && options.descriptionHash.length!==32)
            throw new UserError("Invalid description hash length");

        const {secret, paymentHash} = this.getSecretAndHash();

        const _abortController = extendAbortController(abortSignal);
        preFetches.pricePrefetchPromise ??= this.preFetchPrice(amountData, _abortController.signal);
        preFetches.feeRatePromise ??= this.preFetchFeeRate(signer, amountData, paymentHash.toString("hex"), _abortController);

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: (async () => {
                    const abortController = extendAbortController(_abortController.signal);

                    const liquidityPromise: Promise<BN> = this.preFetchIntermediaryLiquidity(amountData, lp, abortController);

                    const {lnCapacityPromise, resp} = await tryWithRetries(async(retryCount: number) => {
                        const {lnPublicKey, response} = IntermediaryAPI.initFromBTCLN(this.chainIdentifier, lp.url, {
                            paymentHash,
                            amount: amountData.amount,
                            claimer: signer,
                            token: amountData.token.toString(),
                            descriptionHash: options.descriptionHash,
                            exactOut: !amountData.exactIn,
                            feeRate: preFetches.feeRatePromise,
                            additionalParams
                        }, this.options.postRequestTimeout, abortController.signal, retryCount>0 ? false : null);

                        return {
                            lnCapacityPromise: this.preFetchLnCapacity(lnPublicKey),
                            resp: await response
                        };
                    }, null, RequestError, abortController.signal);

                    const decodedPr = bolt11Decode(resp.pr);
                    const amountIn = new BN(decodedPr.millisatoshis).add(new BN(999)).div(new BN(1000));

                    try {
                        this.verifyReturnedData(resp, amountData, lp, options, decodedPr, amountIn);
                        const [pricingInfo] = await Promise.all([
                            this.verifyReturnedPrice(
                                lp.services[SwapType.FROM_BTCLN], false, amountIn, resp.total,
                                amountData.token, resp, preFetches.pricePrefetchPromise, abortController.signal
                            ),
                            this.verifyIntermediaryLiquidity(resp.total, liquidityPromise),
                            this.verifyLnNodeCapacity(lp, decodedPr, amountIn, lnCapacityPromise, abortController.signal)
                        ]);

                        const quote = new FromBTCLNSwap<T>(this, {
                            pricingInfo,
                            url: lp.url,
                            expiry: decodedPr.timeExpireDate*1000,
                            swapFee: resp.swapFee,
                            feeRate: await preFetches.feeRatePromise,
                            data: await this.contract.createSwapData(
                                ChainSwapType.HTLC, lp.getAddress(this.chainIdentifier), signer, amountData.token,
                                resp.total, paymentHash.toString("hex"), null, null, null, null, false, true,
                                resp.securityDeposit, new BN(0)
                            ),
                            pr: resp.pr,
                            secret: secret.toString("hex"),
                            exactIn: amountData.exactIn ?? true
                        } as FromBTCLNSwapInit<T["Data"]>);
                        await quote._save();
                        return quote;
                    } catch (e) {
                        abortController.abort(e);
                        throw e;
                    }
                })()
            }
        });
    }

    /**
     * Parses and fetches lnurl withdraw params from the specified lnurl
     *
     * @param lnurl LNURL to be parsed and fetched
     * @param abortSignal
     * @private
     * @throws {UserError} if the LNURL is invalid or if it's not a LNURL-withdraw
     */
    private async getLNURLWithdraw(lnurl: string | LNURLWithdrawParamsWithUrl, abortSignal: AbortSignal): Promise<LNURLWithdrawParamsWithUrl> {
        if(typeof(lnurl)!=="string") return lnurl;

        const res = await LNURL.getLNURL(lnurl, true, this.options.getRequestTimeout, abortSignal);
        if(res==null) throw new UserError("Invalid LNURL");
        if(res.tag!=="withdrawRequest") throw new UserError("Not a LNURL-withdrawal");
        return res;
    }

    /**
     * Returns a newly created swap, receiving 'amount' from the lnurl-withdraw
     *
     * @param signer                Smart chains signer's address intiating the swap
     * @param lnurl                 LNURL-withdraw to withdraw funds from
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    async createViaLNURL(
        signer: string,
        lnurl: string | LNURLWithdrawParamsWithUrl,
        amountData: AmountData,
        lps: Intermediary[],
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): Promise<{
        quote: Promise<FromBTCLNSwap<T>>,
        intermediary: Intermediary
    }[]> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const abortController = extendAbortController(abortSignal);
        const preFetches = {
            pricePrefetchPromise: this.preFetchPrice(amountData, abortController.signal),
            feeRatePromise: this.preFetchFeeRate(signer, amountData, null, abortController)
        };

        try {
            const exactOutAmountPromise: Promise<BN> = !amountData.exactIn ? preFetches.pricePrefetchPromise.then(price =>
                this.prices.getToBtcSwapAmount(this.chainIdentifier, amountData.amount, amountData.token, abortController.signal, price)
            ).catch(e => {
                abortController.abort(e);
                return null;
            }) : null;

            const withdrawRequest = await this.getLNURLWithdraw(lnurl, abortController.signal);

            const min = new BN(withdrawRequest.minWithdrawable).div(new BN(1000));
            const max = new BN(withdrawRequest.maxWithdrawable).div(new BN(1000));

            if(amountData.exactIn) {
                if(amountData.amount.lt(min)) throw new UserError("Amount less than LNURL-withdraw minimum");
                if(amountData.amount.gt(max)) throw new UserError("Amount more than LNURL-withdraw maximum");
            } else {
                const amount = await exactOutAmountPromise;
                abortController.signal.throwIfAborted();

                if(amount.muln(95).divn(100).lt(min)) throw new UserError("Amount less than LNURL-withdraw minimum");
                if(amount.muln(105).divn(100).gt(max)) throw new UserError("Amount more than LNURL-withdraw maximum");
            }

            return this.create(signer, amountData, lps, null, additionalParams, abortSignal, preFetches).map(data => {
                return {
                    quote: data.quote.then(quote => {
                        quote.lnurl = withdrawRequest.url;
                        quote.lnurlK1 = withdrawRequest.k1;
                        quote.lnurlCallback = withdrawRequest.callback;

                        const amountIn = quote.getInput().rawAmount;
                        if(amountIn.lt(min)) throw new UserError("Amount less than LNURL-withdraw minimum");
                        if(amountIn.gt(max)) throw new UserError("Amount more than LNURL-withdraw maximum");

                        return quote;
                    }),
                    intermediary: data.intermediary
                }
            });
        } catch (e) {
            abortController.abort(e);
            throw e;
        }
    }

}
