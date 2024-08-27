import {IFromBTCWrapper} from "../IFromBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {FromBTCSwap, FromBTCSwapState} from "./FromBTCSwap";
import {MempoolApi} from "../../../btc/MempoolApi";
import {AmountData, ClientSwapContract} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {
    ChainEvents,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    RelaySynchronizer,
    SignatureVerificationError,
    SwapCommitStatus,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {EventEmitter} from "events";
import {Intermediary} from "../../../intermediaries/Intermediary";

export type FromBTCOptions = {
    feeSafetyFactor?: BN,
    blockSafetyFactor?: number
};

export class FromBTCWrapper<T extends SwapData> extends IFromBTCWrapper<T> {

    synchronizer: RelaySynchronizer<any,any,any>;
    listener: (events: SwapEvent<T>[]) => Promise<boolean>;

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param synchronizer              Btc relay synchronizer
     * @param events                    Instance to use for emitting events
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T, synchronizer: RelaySynchronizer<any,any,any>, events?: EventEmitter) {
        super(storage, contract, chainEvents, swapDataDeserializer, events);
        this.synchronizer = synchronizer;
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

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const resultPromises = this.contract.receiveOnchain(
            amountData,
            lps,
            options,
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                quote: data.response.then(response => new FromBTCSwap(
                    this,
                    response.address,
                    response.amount,
                    data.intermediary.url+"/frombtc",
                    response.data,
                    response.fees.swapFee,
                    response.authorization.prefix,
                    response.authorization.timeout,
                    response.authorization.signature,
                    response.authorization.feeRate,
                    response.authorization.expiry,
                    response.pricingInfo
                )),
                intermediary: data.intermediary
            }
        });

        // await swap.save();
        // this.swapData[result.data.getHash()] = swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<FromBTCSwap<T>>(this, FromBTCSwap);

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;
                console.log("Event payment hash: ", paymentHash);
                const swap: FromBTCSwap<T> = this.swapData[paymentHash] as FromBTCSwap<T>;

                console.log("Swap found: ", swap);
                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===FromBTCSwapState.PR_CREATED) {
                        if(swap.data!=null) {
                            try {
                                if(!swap.data.getSequence().eq(event.sequence)) throw new Error("Unexpected data in event, skipping!");
                            } catch (e) {
                                console.error(e);
                                continue;
                            }
                        }
                        swap.state = FromBTCSwapState.CLAIM_COMMITED;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===FromBTCSwapState.PR_CREATED || swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
                        swap.state = FromBTCSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===FromBTCSwapState.PR_CREATED || swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
                        swap.state = FromBTCSwapState.FAILED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        let promise: Promise<any>;
                        if(swap.state===FromBTCSwapState.EXPIRED) {
                            promise = this.storage.removeSwapData(swap)
                        } else {
                            promise = swap.save();
                        }
                        promise.then(() => {
                            swap.emitEvent();
                        });
                    }
                }
            }

            return true;

        };

        this.listener = (events: SwapEvent<T>[]) => {
            console.log("EVENT: ", events);

            if(eventQueue!=null) {
                for(let event of events) {
                    eventQueue.push(event);
                }
                return Promise.resolve(true);
            }

            return processEvent(events);
        };

        this.chainEvents.registerListener(this.listener);

        const changedSwaps = {};


        const processSwap: (swap: FromBTCSwap<T>) => Promise<boolean> = async (swap: FromBTCSwap<T>) => {
            if(swap.state===FromBTCSwapState.PR_CREATED) {
                const status = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));

                if(status===SwapCommitStatus.COMMITED) {
                    swap.state = FromBTCSwapState.CLAIM_COMMITED;
                    //Check if payment already arrived
                    const tx = await MempoolApi.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx!=null && tx.tx.status.confirmed) {
                        const tipHeight = await MempoolApi.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.getConfirmations()) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = FromBTCSwapState.BTC_TX_CONFIRMED;
                        }
                    }
                    return true;
                }

                if(status===SwapCommitStatus.NOT_COMMITED) {
                    //Check if signature is still valid
                    try {
                        await tryWithRetries(
                            () => this.contract.swapContract.isValidInitAuthorization(swap.data, swap.timeout, swap.prefix, swap.signature, swap.feeRate),
                            null,
                            e => e instanceof SignatureVerificationError
                        );
                    } catch (e) {
                        if(e instanceof SignatureVerificationError) {
                            swap.state = FromBTCSwapState.EXPIRED;
                            return true;
                        }
                    }
                    return false;
                }

                if(status===SwapCommitStatus.EXPIRED) {
                    swap.state = FromBTCSwapState.EXPIRED;
                    return true;
                }

                if(status===SwapCommitStatus.PAID) {
                    swap.state = FromBTCSwapState.CLAIM_CLAIMED;
                    return true;
                }
            }

            if(swap.state===FromBTCSwapState.CLAIM_COMMITED || swap.state===FromBTCSwapState.BTC_TX_CONFIRMED) {
                //Check if it's already successfully paid
                const commitStatus = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));
                if(commitStatus===SwapCommitStatus.PAID) {
                    swap.state = FromBTCSwapState.CLAIM_CLAIMED;
                    return true;
                }
                if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                    swap.state = FromBTCSwapState.FAILED;
                    return true;
                }
                if(commitStatus===SwapCommitStatus.COMMITED) {
                    //Check if payment already arrived
                    const tx = await MempoolApi.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx!=null && tx.tx.status.confirmed) {
                        const tipHeight = await MempoolApi.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.getConfirmations()) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = FromBTCSwapState.BTC_TX_CONFIRMED;
                            return true;
                        }
                    }
                }
            }
        };

        let promises = [];
        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash] as FromBTCSwap<T>;

            promises.push(processSwap(swap).then(changed => {
                if(swap.state===FromBTCSwapState.EXPIRED) {
                    this.storage.removeSwapData(swap);
                } else {
                    if(changed) changedSwaps[paymentHash] = true;
                }
            }));

            if(promises.length>=this.MAX_CONCURRENT_REQUESTS) {
                await Promise.all(promises);
                promises = [];
            }
        }

        if(promises.length>0) await Promise.all(promises);

        for(let event of eventQueue) {
            await processEvent([event]);
        }

        eventQueue = null;

        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => this.swapData[e]));

        this.isInitialized = true;
    }


    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwaps(): Promise<FromBTCSwap<T>[]> {
        return Promise.resolve(this.getClaimableSwapsSync());
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwapsSync(): FromBTCSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap: FromBTCSwap<T> = this.swapData[paymentHash] as FromBTCSwap<T>;

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.isClaimable()) {
                returnArr.push(swap);
            }
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwaps(): Promise<FromBTCSwap<T>[]> {
        return Promise.resolve(this.getAllSwapsSync());
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): FromBTCSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    stop(): Promise<void> {
        this.chainEvents.unregisterListener(this.listener);
        return super.stop();
    }

}
