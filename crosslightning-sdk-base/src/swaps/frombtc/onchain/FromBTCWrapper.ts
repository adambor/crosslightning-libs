import {IFromBTCWrapper} from "../IFromBTCWrapper";
import {FromBTCSwap, FromBTCSwapState} from "./FromBTCSwap";
import * as BN from "bn.js";
import {
    ChainEvents, ChainSwapType,
    ClaimEvent,
    InitializeEvent, IStorageManager,
    RefundEvent,
    RelaySynchronizer,
    SwapCommitStatus, SwapContract,
    SwapData
} from "crosslightning-base";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {EventEmitter} from "events";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {BitcoinRpcWithTxoListener} from "../../../btc/BitcoinRpcWithTxoListener";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {networks, address} from "bitcoinjs-lib";
import {AmountData, ISwapWrapperOptions} from "../../ISwapWrapper";
import {Buffer} from "buffer";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController} from "../../../utils/Utils";
import {BtcRelay} from "crosslightning-base/dist";
import {FromBTCResponseType, IntermediaryAPI} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";

export type FromBTCOptions = {
    feeSafetyFactor?: BN,
    blockSafetyFactor?: number
};

export type FromBTCWrapperOptions = ISwapWrapperOptions & {
    safetyFactor?: number,
    blocksTillTxConfirms?: number,
    maxConfirmations?: number,
    minSendWindow?: number,
    bitcoinNetwork?: networks.Network,
    bitcoinBlocktime?: number
};

export class FromBTCWrapper<T extends SwapData> extends IFromBTCWrapper<T, FromBTCSwap<T>, FromBTCWrapperOptions> {
    protected readonly swapDeserializer = FromBTCSwap;

    readonly synchronizer: RelaySynchronizer<any,any,any>;
    readonly btcRelay: BtcRelay<any, T, any>;
    readonly btcRpc: BitcoinRpcWithTxoListener<any>;

    /**
     * @param storage Storage interface for the current environment
     * @param contract Underlying contract handling the swaps
     * @param chainEvents On-chain event listener
     * @param prices Pricing to use
     * @param swapDataDeserializer Deserializer for SwapData
     * @param btcRelay
     * @param synchronizer Btc relay synchronizer
     * @param btcRpc Bitcoin RPC which also supports getting transactions by txoHash
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        storage: IStorageManager<FromBTCSwap<T>>,
        contract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        prices: ISwapPrice,
        swapDataDeserializer: new (data: any) => T,
        btcRelay: BtcRelay<any, T, any>,
        synchronizer: RelaySynchronizer<any,any,any>,
        btcRpc: BitcoinRpcWithTxoListener<any>,
        options?: FromBTCWrapperOptions,
        events?: EventEmitter<{swapState: [FromBTCSwap<T>]}>
    ) {
        if(options==null) options = {};
        options.bitcoinNetwork = options.bitcoinNetwork || networks.testnet;
        options.safetyFactor = options.safetyFactor || 2;
        options.blocksTillTxConfirms = options.blocksTillTxConfirms || 12;
        options.maxConfirmations = options.maxConfirmations || 6;
        options.minSendWindow = options.minSendWindow || 30*60; //Minimum time window for user to send in the on-chain funds for From BTC swap
        options.bitcoinBlocktime = options.bitcoinBlocktime || 10*60;
        super(storage, contract, chainEvents, prices, swapDataDeserializer, options, events);
        this.btcRelay = btcRelay;
        this.synchronizer = synchronizer;
        this.btcRpc = btcRpc;
    }

    protected async checkPastSwap(swap: FromBTCSwap<T>): Promise<boolean> {
        if(swap.state===FromBTCSwapState.PR_CREATED) {
            try {
                const status = await tryWithRetries(() => this.contract.getCommitStatus(swap.data));
                switch(status) {
                    case SwapCommitStatus.COMMITED:
                        swap.state = FromBTCSwapState.CLAIM_COMMITED;
                        return true;
                    case SwapCommitStatus.REFUNDABLE:
                        swap.state = FromBTCSwapState.FAILED;
                        return true;
                    case SwapCommitStatus.EXPIRED:
                        swap.state = FromBTCSwapState.QUOTE_EXPIRED;
                        return true;
                    case SwapCommitStatus.PAID:
                        swap.state = FromBTCSwapState.CLAIM_CLAIMED;
                        return true;
                }

                if(!await swap.isQuoteValid()) {
                    swap.state = FromBTCSwapState.QUOTE_EXPIRED;
                    return true;
                }
            } catch (e) {
                console.error(e);
            }

            return false;
        }

        if(swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
            try {
                const status = await tryWithRetries(() => this.contract.getCommitStatus(swap.data));
                switch(status) {
                    case SwapCommitStatus.PAID:
                        swap.state = FromBTCSwapState.CLAIM_CLAIMED;
                        return true;
                    case SwapCommitStatus.NOT_COMMITED:
                    case SwapCommitStatus.EXPIRED:
                        swap.state = FromBTCSwapState.FAILED;
                        return true;
                    case SwapCommitStatus.COMMITED:
                        const res = await swap.getBitcoinPayment();
                        if(res!=null && res.confirmations>=swap.data.getConfirmations()) {
                            swap.txId = res.txId;
                            swap.vout = res.vout;
                            swap.state = FromBTCSwapState.BTC_TX_CONFIRMED;
                            return true;
                        }
                        break;
                }
            } catch (e) {
                console.error(e);
            }
        }
    }

    protected async processEventInitialize(swap: FromBTCSwap<T>, event: InitializeEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCSwapState.PR_CREATED) {
            if(swap.data!=null && !swap.data.getSequence().eq(event.sequence)) return false;
            swap.state = FromBTCSwapState.CLAIM_COMMITED;
            return true;
        }
        return false;
    }

    protected processEventClaim(swap: FromBTCSwap<T>, event: ClaimEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCSwapState.PR_CREATED || swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
            swap.state = FromBTCSwapState.CLAIM_CLAIMED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected processEventRefund(swap: FromBTCSwap<T>, event: RefundEvent<T>): Promise<boolean> {
        if(swap.state===FromBTCSwapState.PR_CREATED || swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
            swap.state = FromBTCSwapState.FAILED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    getOnchainSendTimeout(data: SwapData): BN {
        const tsDelta = (this.options.blocksTillTxConfirms + data.getConfirmations()) * this.options.bitcoinBlocktime * this.options.safetyFactor;
        return data.getExpiry().sub(new BN(tsDelta));
    }

    private async preFetchClaimerBounty(
        amountData: AmountData,
        options: FromBTCOptions,
        abortController: AbortController
    ): Promise<{
        feePerBlock: BN,
        safetyFactor: number,
        startTimestamp: BN,
        addBlock: number,
        addFee: BN
    } | null> {
        const startTimestamp = new BN(Math.floor(Date.now()/1000));

        const dummySwapData = await this.contract.createSwapData(
            ChainSwapType.CHAIN, null, this.contract.getAddress(), amountData.token,
            null, null, null, null, null, null, false, true, null, null
        );

        try {
            const [feePerBlock, btcRelayData, currentBtcBlock, claimFeeRate] = await Promise.all([
                tryWithRetries(() => this.btcRelay.getFeePerBlock(), null, null, abortController.signal),
                tryWithRetries(() => this.btcRelay.getTipData(), null, null, abortController.signal),
                tryWithRetries(() => this.btcRpc.getTipHeight(), null, null, abortController.signal),
                tryWithRetries<BN>(
                    () => (this.contract as any).getRawClaimFee!=null ?
                        (this.contract as any).getRawClaimFee(dummySwapData) :
                        this.contract.getClaimFee(dummySwapData),
                    null, null, abortController.signal
                )
            ]);

            const currentBtcRelayBlock = btcRelayData.blockheight;
            const addBlock = Math.max(currentBtcBlock-currentBtcRelayBlock, 0);
            return {
                feePerBlock: feePerBlock.mul(options.feeSafetyFactor),
                safetyFactor: options.blockSafetyFactor,
                startTimestamp: startTimestamp,
                addBlock,
                addFee: claimFeeRate.mul(options.feeSafetyFactor)
            }
        } catch (e) {
            abortController.abort(e);
            return null;
        }
    }

    private getTotalClaimerBounty(
        data: T,
        options: FromBTCOptions,
        claimerBounty: {
            feePerBlock: BN,
            safetyFactor: number,
            startTimestamp: BN,
            addBlock: number,
            addFee: BN
        }
    ): BN {
        const tsDelta = data.getExpiry().sub(claimerBounty.startTimestamp);
        const blocksDelta = tsDelta.div(new BN(this.options.bitcoinBlocktime)).mul(new BN(options.blockSafetyFactor));
        const totalBlock = blocksDelta.add(new BN(claimerBounty.addBlock));
        return claimerBounty.addFee.add(totalBlock.mul(claimerBounty.feePerBlock));
    }

    private verifyReturnedData(
        resp: FromBTCResponseType,
        amountData: AmountData,
        lp: Intermediary,
        options: FromBTCOptions,
        data: T,
        sequence: BN,
        claimerBounty: {
            feePerBlock: BN,
            safetyFactor: number,
            startTimestamp: BN,
            addBlock: number,
            addFee: BN
        }
    ): void {
        if(amountData.exactIn) {
            if(!resp.amount.eq(amountData.amount)) throw new IntermediaryError("Invalid amount returned");
        } else {
            if(!resp.total.eq(amountData.amount)) throw new IntermediaryError("Invalid total returned");
        }

        if(data.getConfirmations()>this.options.maxConfirmations) throw new IntermediaryError("Requires too many confirmations");

        const totalClaimerBounty = this.getTotalClaimerBounty(data, options, claimerBounty);

        if(
            !data.getClaimerBounty().eq(totalClaimerBounty) ||
            data.getType()!=ChainSwapType.CHAIN ||
            !data.getSequence().eq(sequence) ||
            !data.getAmount().eq(resp.total) ||
            data.isPayIn() ||
            !data.isToken(amountData.token) ||
            data.getOfferer()!==lp.address
        ) {
            throw new IntermediaryError("Invalid data returned");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = this.getOnchainSendTimeout(data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));
        if(expiry.sub(currentTimestamp).lt(new BN(this.options.minSendWindow))) {
            throw new IntermediaryError("Send window too low");
        }

        const lockingScript = address.toOutputScript(resp.btcAddress, this.options.bitcoinNetwork);
        const desiredHash = this.contract.getHashForOnchain(lockingScript, resp.amount, new BN(0));
        const suppliedHash = Buffer.from(data.getHash(),"hex");
        if(!desiredHash.equals(suppliedHash)) {
            throw new IntermediaryError("Invalid payment hash returned!");
        }
    }

    /**
     * Returns a newly created swap, receiving 'amount' on chain
     *
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    create(
        amountData: AmountData,
        lps: Intermediary[],
        options?: FromBTCOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): {
        quote: Promise<FromBTCSwap<T>>,
        intermediary: Intermediary
    }[] {
        if(options==null) options = {};
        options.blockSafetyFactor = options.blockSafetyFactor || 2;
        options.feeSafetyFactor = options.feeSafetyFactor || new BN(2);

        const sequence: BN = this.getRandomSequence();

        const _abortController = extendAbortController(abortSignal);
        const pricePrefetchPromise: Promise<BN> = this.preFetchPrice(amountData, _abortController.signal);
        const claimerBountyPrefetchPromise = this.preFetchClaimerBounty(amountData, options, _abortController);
        const feeRatePromise: Promise<any> = this.preFetchFeeRate(amountData, null, _abortController);

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: (async () => {
                    const abortController = extendAbortController(_abortController.signal);
                    const liquidityPromise: Promise<BN> = this.preFetchIntermediaryLiquidity(amountData, lp, abortController);

                    try {
                        const {signDataPromise, resp} = await tryWithRetries(async() => {
                            const {signDataPrefetch, response} = IntermediaryAPI.initFromBTC(lp.url, {
                                claimer: this.contract.getAddress(),
                                amount: amountData.amount,
                                token: amountData.token.toString(),

                                exactOut: !amountData.exactIn,
                                sequence,

                                claimerBounty: claimerBountyPrefetchPromise,
                                feeRate: feeRatePromise,
                                additionalParams
                            }, this.options.postRequestTimeout, abortController.signal);

                            return {
                                signDataPromise: this.preFetchSignData(signDataPrefetch),
                                resp: await response
                            };
                        }, null, e => e instanceof RequestError, abortController.signal);

                        const data: T = new this.swapDataDeserializer(resp.data);
                        this.contract.setUsAsClaimer(data);

                        this.verifyReturnedData(resp, amountData, lp, options, data, sequence, await claimerBountyPrefetchPromise);
                        const [pricingInfo, signatureExpiry] = await Promise.all([
                            //Get intermediary's liquidity
                            this.verifyReturnedPrice(
                                lp.services[SwapType.FROM_BTC], false, resp.amount, resp.total,
                                data.getAmount(), resp, pricePrefetchPromise, abortController.signal
                            ),
                            this.verifyReturnedSignature(data, resp, feeRatePromise, signDataPromise, abortController.signal),
                            this.verifyIntermediaryLiquidity(lp, data.getAmount(), data.getToken(), liquidityPromise),
                        ]);

                        return new FromBTCSwap<T>(this, {
                            pricingInfo,
                            url: lp.url,
                            expiry: signatureExpiry,
                            swapFee: resp.swapFee,
                            feeRate: await feeRatePromise,
                            prefix: resp.prefix,
                            timeout: resp.timeout,
                            signature: resp.signature,
                            data,
                            address: resp.address,
                            amount: resp.amount
                        });
                    } catch (e) {
                        abortController.abort(e);
                        throw e;
                    }
                })()
            }
        });
    }

}
