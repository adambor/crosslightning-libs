import {FromBTCLNSwap, FromBTCLNSwapState} from "./FromBTCLNSwap";
import {IFromBTCWrapper} from "../IFromBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {AmountData, ClientSwapContract, LNURLWithdraw, PaymentAuthError} from "../../ClientSwapContract";
import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SignatureVerificationError,
    SwapCommitStatus,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {EventEmitter} from "events";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {Buffer} from "buffer";

export type FromBTCLNOptions = {
    descriptionHash?: Buffer
};

export class FromBTCLNWrapper<T extends SwapData> extends IFromBTCWrapper<T> {

    listener: (events: SwapEvent<T>[]) => Promise<boolean>;

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param events                    Instance to use for emitting events
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T, events?: EventEmitter) {
        super(storage, contract, chainEvents, swapDataDeserializer, events);
    }

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
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
        options: FromBTCLNOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): {
        quote: Promise<FromBTCLNSwap<T>>,
        intermediary: Intermediary
    }[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const resultPromises = this.contract.receiveLightning(
            amountData,
            lps,
            options,
            null,
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                intermediary: data.intermediary,
                quote: data.response.then(response => {
                    const parsed = bolt11.decode(response.pr);
                    return this.contract.swapContract.createSwapData(
                        ChainSwapType.HTLC,
                        data.intermediary.address,
                        this.contract.swapContract.getAddress(),
                        amountData.token,
                        response.amount,
                        parsed.tagsObject.payment_hash,
                        null,
                        null,
                        null,
                        null,
                        false,
                        true,
                        response.fees.securityDeposit,
                        new BN(0)
                    ).then(swapData => new FromBTCLNSwap<T>(
                        this,
                        response.pr,
                        response.secret,
                        data.intermediary.url+"/frombtcln",
                        swapData,
                        response.fees.swapFee,
                        null,
                        null,
                        response.amount,
                        response.pricingInfo,
                        response.authorization.feeRate,
                        null,
                        null,
                        null,
                        null,
                        null
                    ))
                })
            }
        });

        //Saved when waitForPayment is called
        // await swap.save();
        // this.swapData[swap.getPaymentHash().toString("hex")] = swap;
        // this.events.emit("swapCreated", swap);
        //
        // return swap;

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
        lnurl: string | LNURLWithdraw,
        amountData: AmountData,
        lps: Intermediary[],
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): Promise<{
        quote: Promise<FromBTCLNSwap<T>>,
        intermediary: Intermediary
    }[]> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const resultPromises = await this.contract.receiveLightningLNURL(
            typeof(lnurl)==="string" ? lnurl : lnurl.params,
            amountData,
            lps,
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                intermediary: data.intermediary,
                quote: data.response.then(response => {
                    const parsed = bolt11.decode(response.pr);
                    return this.contract.swapContract.createSwapData(
                        ChainSwapType.HTLC,
                        data.intermediary.address,
                        this.contract.swapContract.getAddress(),
                        amountData.token,
                        response.amount,
                        parsed.tagsObject.payment_hash,
                        null,
                        null,
                        null,
                        null,
                        false,
                        true,
                        response.fees.securityDeposit,
                        new BN(0)
                    ).then(swapData => new FromBTCLNSwap<T>(
                        this,
                        response.pr,
                        response.secret,
                        data.intermediary.url+"/frombtcln",
                        swapData,
                        response.fees.swapFee,
                        null,
                        null,
                        response.amount,
                        response.pricingInfo,
                        response.authorization.feeRate,
                        typeof(lnurl)==="string" ? lnurl : lnurl.params.url,
                        null,
                        response.withdrawRequest.k1,
                        response.withdrawRequest.callback,
                        false
                    ))
                })
            }
        });

        //Saved when waitForPayment is called
        // await swap.save();
        // this.swapData[swap.getPaymentHash().toString("hex")] = swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        console.log("Deserializers: ", SwapData.deserializers);

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<FromBTCLNSwap<T>>(this, FromBTCLNSwap);

        console.log("Swap data loaded");

        const processEvent = async (events: SwapEvent<T>[]) => {


            for(let event of events) {
                const paymentHash = event.paymentHash;

                console.log("Event payment hash: ", paymentHash);

                const swap: FromBTCLNSwap<T> = this.swapData[paymentHash] as FromBTCLNSwap<T>;

                console.log("Swap found: ", swap);

                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID) {
                        const swapData = await event.swapData();
                        if(swap.data!=null) {
                            try {
                                if(!swap.data.equals(swapData)) throw new Error("Unexpected data in event, skipping!");
                            } catch (e) {
                                console.error(e);
                                continue;
                            }
                        }
                        if(swap.state===FromBTCLNSwapState.PR_PAID) {
                            swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
                        }
                        swap.data = swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                        swap.state = FromBTCLNSwapState.FAILED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        let promise: Promise<any>;
                        if(swap.state===FromBTCLNSwapState.EXPIRED) {
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

        console.log("Loaded FromBTCLN: ", this.swapData);

        const processSwap: (swap: FromBTCLNSwap<T>) => Promise<boolean> = async (swap: FromBTCLNSwap<T>) => {
            if(swap.state===FromBTCLNSwapState.PR_CREATED) {
                if(swap.getTimeoutTime()<Date.now()) {
                    swap.state = FromBTCLNSwapState.EXPIRED;
                    return true;
                }

                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.pr, swap.url, swap.data.getToken(), swap.data.getOfferer(), swap.requiredBaseFee, swap.requiredFeePPM);
                    if(res.is_paid) {
                        swap.state = FromBTCLNSwapState.PR_PAID;

                        swap.data = res.data;
                        swap.prefix = res.prefix;
                        swap.timeout = res.timeout;
                        swap.signature = res.signature;

                        swap.expiry = res.expiry;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                    if(e instanceof PaymentAuthError) {
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                }
                return false;
            }

            if(swap.state===FromBTCLNSwapState.PR_PAID) {
                //Check if it's already committed
                try {
                    const status = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));
                    if(status===SwapCommitStatus.PAID) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(status===SwapCommitStatus.EXPIRED) {
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                    if(status===SwapCommitStatus.COMMITED) {
                        swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                }

                try {
                    await tryWithRetries(
                        () => this.contract.swapContract.isValidInitAuthorization(swap.data, swap.timeout, swap.prefix, swap.signature, swap.feeRate),
                        null,
                        (e) => e instanceof SignatureVerificationError
                    );
                } catch (e) {
                    console.error(e);
                    if(e instanceof SignatureVerificationError) {
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                }

                return false;
            }

            if(swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                try {
                    const commitStatus = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));
                    if(commitStatus===SwapCommitStatus.PAID) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                        swap.state = FromBTCLNSwapState.FAILED;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                }
                return false;
            }
        };

        let promises = [];
        for(let paymentHash in this.swapData) {
            const swap: FromBTCLNSwap<T> = this.swapData[paymentHash] as FromBTCLNSwap<T>;

            promises.push(processSwap(swap).then(changed => {
                if(swap.state===FromBTCLNSwapState.EXPIRED) {
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

        console.log("Swap data checked");

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
    getClaimableSwaps(): Promise<FromBTCLNSwap<T>[]> {
        return Promise.resolve(this.getClaimableSwapsSync());
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwapsSync(): FromBTCLNSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: FromBTCLNSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            const castedSwap = swap as FromBTCLNSwap<T>;

            if(castedSwap.isClaimable()) {
                returnArr.push(castedSwap);
            }
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwaps(): Promise<FromBTCLNSwap<T>[]> {
        return Promise.resolve(this.getAllSwapsSync());
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): FromBTCLNSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: FromBTCLNSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap as FromBTCLNSwap<T>);
        }

        return returnArr;

    }

    stop(): Promise<void> {
        this.chainEvents.unregisterListener(this.listener);
        return super.stop();
    }

}
