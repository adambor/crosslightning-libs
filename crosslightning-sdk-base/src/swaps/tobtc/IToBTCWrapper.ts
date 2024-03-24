import {IToBTCSwap, ToBTCSwapState} from "./IToBTCSwap";
import {IWrapperStorage} from "../../storage/IWrapperStorage";
import {ClientSwapContract} from "../ClientSwapContract";
import * as BN from "bn.js";
import * as EventEmitter from "events";
import {SwapCommitStatus, SwapData, TokenAddress, ChainEvents, RefundEvent, ClaimEvent,
    InitializeEvent, SwapEvent, SignatureVerificationError} from "crosslightning-base";
import {FromBTCLNSwapState, FromBTCSwap, FromBTCSwapState} from "../..";
import {tryWithRetries} from "../../utils/RetryUtils";


export abstract class IToBTCWrapper<T extends SwapData> {

    readonly MAX_CONCURRENT_REQUESTS: number = 10;

    readonly storage: IWrapperStorage;
    readonly contract: ClientSwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    listener: (events: SwapEvent<T>[]) => Promise<boolean>;
    readonly swapDataDeserializer: new (data: any) => T;

    /**
     * Event emitter for all the swaps
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    swapData: {[paymentHash: string]: IToBTCSwap<T>};

    isInitialized: boolean = false;

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     */
    protected constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T) {
        this.storage = storage;
        this.contract = contract;
        this.chainEvents = chainEvents;
        this.swapDataDeserializer = swapDataDeserializer;
        this.events = new EventEmitter();
    }

    abstract init(): Promise<void>;

    /**
     * Returns the token balance of the wallet
     */
    getBalance(token: TokenAddress): Promise<BN> {
        return this.contract.swapContract.getBalance(token, false);
    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    protected async initWithConstructor(constructor: new (wrapper: any, data: any) => IToBTCSwap<T>): Promise<void> {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<IToBTCSwap<T>>(this, constructor);

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;
                console.log("Event payment hash: ", paymentHash);

                const swap: IToBTCSwap<T> = this.swapData[paymentHash];

                console.log("Swap found: ", swap);

                if(swap==null) return;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===ToBTCSwapState.CREATED) {
                        const swapData = await event.swapData();
                        if(swap.data!=null) {
                            try {
                                if(!swap.data.equals(swapData)) throw new Error("Unexpected data in event, skipping!");
                            } catch (e) {
                                console.error(e);
                                continue;
                            }
                        }
                        swap.state = ToBTCSwapState.COMMITED;
                        swap.data = swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.REFUNDABLE) {
                        swap.state = ToBTCSwapState.CLAIMED;
                        swap.secret = event.secret;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.REFUNDABLE) {
                        swap.state = ToBTCSwapState.REFUNDED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        let promise: Promise<any>;
                        if(swap.state===ToBTCSwapState.FAILED) {
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

        const processSwap: (swap: IToBTCSwap<T>) => Promise<boolean> = async (swap: IToBTCSwap<T>) => {
            if(swap.state===ToBTCSwapState.CREATED) {
                //Check if it's already committed
                const res = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));
                if(res===SwapCommitStatus.PAID) {
                    swap.state = ToBTCSwapState.CLAIMED;
                    return true;
                }
                if(res===SwapCommitStatus.EXPIRED) {
                    swap.state = ToBTCSwapState.FAILED;
                    return true;
                }
                if(res===SwapCommitStatus.COMMITED) {
                    swap.state = ToBTCSwapState.COMMITED;
                    return true;
                }
                if(res===SwapCommitStatus.REFUNDABLE) {
                    swap.state = ToBTCSwapState.REFUNDABLE;
                    return true;
                }

                //Not committed yet, check if still valid
                try {
                    await tryWithRetries(
                        () => this.contract.swapContract.isValidClaimInitAuthorization(swap.data, swap.timeout, swap.prefix, swap.signature, swap.feeRate),
                        null,
                        e => e instanceof SignatureVerificationError
                    );
                } catch (e) {
                    if(e instanceof SignatureVerificationError) {
                        swap.state = ToBTCSwapState.FAILED;
                        return true;
                    }
                }

                return false;
            }

            if(swap.state===ToBTCSwapState.COMMITED) {
                const res = await tryWithRetries(() => this.contract.swapContract.getCommitStatus(swap.data));
                if(res===SwapCommitStatus.COMMITED) {
                    //Check if that maybe already concluded
                    try {
                        const refundAuth = await this.contract.getRefundAuthorization(swap.data, swap.url);
                        if(refundAuth!=null) {
                            if(!refundAuth.is_paid) {
                                swap.state = ToBTCSwapState.REFUNDABLE;
                                return true;
                            } else {
                                swap.secret = refundAuth.secret;
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
                if(res===SwapCommitStatus.NOT_COMMITED) {
                    swap.state = ToBTCSwapState.REFUNDED;
                    return true;
                }
                if(res===SwapCommitStatus.PAID) {
                    swap.state = ToBTCSwapState.CLAIMED;
                    return true;
                }
                if(res===SwapCommitStatus.EXPIRED) {
                    swap.state = ToBTCSwapState.FAILED;
                    return true;
                }
                if(res===SwapCommitStatus.REFUNDABLE) {
                    swap.state = ToBTCSwapState.REFUNDABLE;
                    return true;
                }
            }
        };

        let promises = [];
        for(let paymentHash in this.swapData) {
            const swap: IToBTCSwap<T> = this.swapData[paymentHash];

            promises.push(processSwap(swap).then(changed => {
                if(swap.state===ToBTCSwapState.FAILED) {
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

        const swapsToSave = Object.keys(changedSwaps).map(e => this.swapData[e]);

        await this.storage.saveSwapDataArr(swapsToSave);

        this.isInitialized = true;

    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    getRefundableSwaps(): Promise<IToBTCSwap<T>[]> {
        return Promise.resolve(this.getRefundableSwapsSync());
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    getRefundableSwapsSync(): IToBTCSwap<T>[] {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: IToBTCSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getOfferer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.isRefundable()) {
                returnArr.push(swap);
            }
        }

        return returnArr;
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwaps(): Promise<IToBTCSwap<T>[]> {
        return Promise.resolve(this.getAllSwapsSync());
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): IToBTCSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: IToBTCSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getOfferer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Un-subscribes from event listeners on Solana
     */
    async stop() {
        this.swapData = null;
        this.isInitialized = false;
        this.chainEvents.unregisterListener(this.listener);
    }

}
