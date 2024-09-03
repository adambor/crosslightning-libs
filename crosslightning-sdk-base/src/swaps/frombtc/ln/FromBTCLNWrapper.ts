import {FromBTCLNSwap, FromBTCLNSwapState} from "./FromBTCLNSwap";
import {IFromBTCWrapper} from "../IFromBTCWrapper";
import * as BN from "bn.js";
import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    IStorageManager,
    RefundEvent,
    SwapCommitStatus, SwapContract,
    SwapData
} from "crosslightning-base";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {Buffer} from "buffer";
import {UserError} from "../../../errors/UserError";
import randomBytes from "randombytes";
import createHash from "create-hash";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController, tryWithRetries} from "../../../utils/Utils";
import {FromBTCLNResponseType, IntermediaryAPI} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";
import {LightningNetworkApi, LNNodeLiquidity} from "../../../btc/LightningNetworkApi";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {EventEmitter} from "events";
import {AmountData, ISwapWrapperOptions} from "../../ISwapWrapper";
import {LNURL, LNURLWithdrawParamsWithUrl} from "../../../utils/LNURL";

export type FromBTCLNOptions = {
    descriptionHash?: Buffer
};

export class FromBTCLNWrapper<T extends SwapData> extends IFromBTCWrapper<T, FromBTCLNSwap<T>> {
    protected readonly swapDeserializer = FromBTCLNSwap;

    protected readonly lnApi: LightningNetworkApi;

    /**
     * @param storage Storage interface for the current environment
     * @param contract Underlying contract handling the swaps
     * @param prices Swap pricing handler
     * @param chainEvents On-chain event listener
     * @param swapDataDeserializer Deserializer for SwapData
     * @param lnApi
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        storage: IStorageManager<FromBTCLNSwap<T>>,
        contract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        prices: ISwapPrice,
        swapDataDeserializer: new (data: any) => T,
        lnApi: LightningNetworkApi,
        options: ISwapWrapperOptions,
        events?: EventEmitter<{swapState: [FromBTCLNSwap<T>]}>
    ) {
        super(storage, contract, chainEvents, prices, swapDataDeserializer, options, events);
        this.lnApi = lnApi;
    }

    protected async checkPastSwap(swap: FromBTCLNSwap<T>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_CREATED) {
            if(swap.getTimeoutTime()<Date.now()) {
                swap.state = FromBTCLNSwapState.QUOTE_EXPIRED;
                return true;
            }

            const result = await swap.checkLPPaymentReceived(false);
            if(result!==null) return true;
        }

        if(swap.state===FromBTCLNSwapState.PR_PAID) {
            //Check if it's already committed
            try {
                const status = await tryWithRetries(() => this.contract.getCommitStatus(swap.data));
                switch(status) {
                    case SwapCommitStatus.PAID:
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        return true;
                    case SwapCommitStatus.EXPIRED:
                    case SwapCommitStatus.REFUNDABLE:
                        swap.state = FromBTCLNSwapState.FAILED;
                        return true;
                    case SwapCommitStatus.COMMITED:
                        swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
                        return true;
                }

                if(!await swap.isQuoteValid()) {
                    swap.state = FromBTCLNSwapState.FAILED;
                    return true;
                }
            } catch (e) {
                console.error(e);
            }

            return false;
        }

        if(swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            //Check if it's already successfully paid
            try {
                const commitStatus = await tryWithRetries(() => this.contract.getCommitStatus(swap.data));
                if(commitStatus===SwapCommitStatus.PAID) {
                    swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                    return true;
                }
                if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED || commitStatus===SwapCommitStatus.REFUNDABLE) {
                    swap.state = FromBTCLNSwapState.FAILED;
                    return true;
                }
            } catch (e) {
                console.error(e);
            }
            return false;
        }
    }

    protected async processEventInitialize(swap: FromBTCLNSwap<T>, event: InitializeEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_PAID) {
            const swapData = await event.swapData();
            if(swap.data!=null && !swap.data.equals(swapData)) return false;
            swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
            swap.data = swapData;
            return true;
        }
    }

    protected processEventClaim(swap: FromBTCLNSwap<T>, event: ClaimEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected processEventRefund(swap: FromBTCLNSwap<T>, event: RefundEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            swap.state = FromBTCLNSwapState.FAILED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    private getSecretAndHash(): {secret: Buffer, paymentHash: Buffer} {
        const secret = randomBytes(32);
        const paymentHash = createHash("sha256").update(secret).digest();
        return {secret, paymentHash};
    }

    private preFetchLnCapacity(pubkeyPromise: Promise<string>): Promise<LNNodeLiquidity | null> {
        return pubkeyPromise.then(pubkey => {
            if(pubkey==null) return null;
            return this.lnApi.getLNNodeLiquidity(pubkey)
        }).catch(e => {
            console.error(e);
            return null;
        })
    }

    private verifyReturnedData(
        resp: FromBTCLNResponseType,
        amountData: AmountData,
        lp: Intermediary,
        options: FromBTCLNOptions,
        decodedPr: PaymentRequestObject & {tagsObject: TagsObject},
        amountIn: BN
    ): void {
        if(lp.address!==resp.intermediaryKey) throw new IntermediaryError("Invalid intermediary address/pubkey");

        if(options.descriptionHash!=null && decodedPr.tagsObject.purpose_commit_hash!==options.descriptionHash.toString("hex"))
            throw new IntermediaryError("Invalid pr returned - description hash");

        if(!amountData.exactIn) {
            if(!resp.total.eq(amountData.amount)) throw new IntermediaryError("Invalid amount returned");
        } else {
            if(!amountIn.eq(amountData.amount)) throw new IntermediaryError("Invalid payment request returned, amount mismatch");
        }
    }

    private async verifyLnNodeCapacity(
        lp: Intermediary,
        decodedPr: PaymentRequestObject & {tagsObject: TagsObject},
        amountIn: BN,
        lnCapacityPrefetchPromise: Promise<LNNodeLiquidity | null>,
        abortSignal?: AbortSignal
    ) {
        let result: LNNodeLiquidity = await lnCapacityPrefetchPromise;
        if(result==null) result = await tryWithRetries(
            () => this.lnApi.getLNNodeLiquidity(decodedPr.payeeNodeKey),
            null, null, abortSignal
        );

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
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     * @param preFetches
     */
    create(
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
        preFetches.feeRatePromise ??= this.preFetchFeeRate(amountData, paymentHash.toString("hex"), _abortController);

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: (async () => {
                    const abortController = extendAbortController(_abortController.signal);

                    const liquidityPromise: Promise<BN> = this.preFetchIntermediaryLiquidity(amountData, lp, abortController);

                    const {lnCapacityPromise, resp} = await tryWithRetries(async() => {
                        const {lnPublicKey, response} = IntermediaryAPI.initFromBTCLN(lp.url, {
                            paymentHash,
                            amount: amountData.amount,
                            claimer: this.contract.getAddress(),
                            token: amountData.token.toString(),
                            descriptionHash: options.descriptionHash,
                            exactOut: !amountData.exactIn,
                            feeRate: preFetches.feeRatePromise,
                            additionalParams
                        }, this.options.postRequestTimeout, abortController.signal);

                        return {
                            lnCapacityPromise: this.preFetchLnCapacity(lnPublicKey),
                            resp: await response
                        };
                    }, null, e => e instanceof RequestError, abortController.signal);

                    const decodedPr = bolt11Decode(resp.pr);
                    const amountIn = new BN(decodedPr.millisatoshis).add(new BN(999)).div(new BN(1000));

                    try {
                        this.verifyReturnedData(resp, amountData, lp, options, decodedPr, amountIn);
                        const [pricingInfo] = await Promise.all([
                            this.verifyReturnedPrice(
                                lp.services[SwapType.FROM_BTCLN], false, amountIn, resp.total,
                                amountData.token, resp, preFetches.pricePrefetchPromise, abortController.signal
                            ),
                            this.verifyIntermediaryLiquidity(lp, resp.total, amountData.token, liquidityPromise),
                            this.verifyLnNodeCapacity(lp, decodedPr, amountIn, lnCapacityPromise, abortController.signal)
                        ]);

                        return new FromBTCLNSwap<T>(this, {
                            pricingInfo,
                            url: lp.url,
                            expiry: decodedPr.timeExpireDate*1000,
                            swapFee: resp.swapFee,
                            feeRate: await preFetches.feeRatePromise,
                            data: await this.contract.createSwapData(
                                ChainSwapType.HTLC,
                                lp.address,
                                this.contract.getAddress(),
                                amountData.token,
                                resp.total,
                                paymentHash.toString("hex"),
                                null,
                                null,
                                null,
                                null,
                                false,
                                true,
                                resp.securityDeposit,
                                new BN(0)
                            ),
                            pr: resp.pr,
                            secret: secret
                        });
                    } catch (e) {
                        abortController.abort(e);
                        throw e;
                    }
                })()
            }
        });
    }

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
     * @param lnurl                 LNURL-withdraw to withdraw funds from
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    async createViaLNURL(
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
            feeRatePromise: this.preFetchFeeRate(amountData, null, abortController)
        };

        try {
            const exactOutAmountPromise: Promise<BN> = !amountData.exactIn ? preFetches.pricePrefetchPromise.then(price =>
                this.prices.getToBtcSwapAmount(amountData.amount, amountData.token, abortController.signal, price)
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

            return this.create(amountData, lps, null, additionalParams, abortSignal, preFetches).map(data => {
                return {
                    quote: data.quote.then(quote => {
                        quote.lnurl = withdrawRequest.url;
                        quote.lnurlK1 = withdrawRequest.k1;
                        quote.lnurlCallback = withdrawRequest.callback;

                        const amountIn = quote.getInAmount();
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
