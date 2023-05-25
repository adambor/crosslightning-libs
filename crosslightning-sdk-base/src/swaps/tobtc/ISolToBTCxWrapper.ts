import {ISolToBTCxSwap, SolToBTCxSwapState} from "./ISolToBTCxSwap";
import {IWrapperStorage} from "../../storage/IWrapperStorage";
import {ClientSwapContract} from "../ClientSwapContract";
import * as BN from "bn.js";
import * as EventEmitter from "events";
import {SwapCommitStatus, SwapData, TokenAddress, ChainEvents, RefundEvent, ClaimEvent,
    InitializeEvent, SwapEvent} from "crosslightning-base";


export abstract class ISolToBTCxWrapper<T extends SwapData> {

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

    swapData: {[paymentHash: string]: ISolToBTCxSwap<T>};

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
    protected async initWithConstructor(constructor: new (wrapper: any, data: any) => ISolToBTCxSwap<T>): Promise<void> {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<ISolToBTCxSwap<T>>(this, constructor);

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;
                console.log("Event payment hash: ", paymentHash);

                const swap: ISolToBTCxSwap<T> = this.swapData[paymentHash];

                console.log("Swap found: ", swap);

                if(swap==null) return;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===SolToBTCxSwapState.CREATED) {
                        swap.state = SolToBTCxSwapState.COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===SolToBTCxSwapState.CREATED || swap.state===SolToBTCxSwapState.COMMITED || swap.state===SolToBTCxSwapState.REFUNDABLE) {
                        swap.state = SolToBTCxSwapState.CLAIMED;
                        swap.secret = event.secret;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===SolToBTCxSwapState.CREATED || swap.state===SolToBTCxSwapState.COMMITED || swap.state===SolToBTCxSwapState.REFUNDABLE) {
                        swap.state = SolToBTCxSwapState.REFUNDED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        swap.save().then(() => {
                            swap.emitEvent();
                        });
                    }
                }
            }

            return true;

        };

        this.listener = (events: SwapEvent<T>[]) => {
            console.log("EVENT: ", event);

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

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            if(swap.state===SolToBTCxSwapState.CREATED) {
                //Check if it's already committed
                const res = await this.contract.swapContract.getCommitStatus(swap.data);
                if(res===SwapCommitStatus.PAID) {
                    swap.state = SolToBTCxSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.EXPIRED) {
                    swap.state = SolToBTCxSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.COMMITED) {
                    swap.state = SolToBTCxSwapState.COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.REFUNDABLE;
                    changedSwaps[paymentHash] = swap;
                }
            }

            if(swap.state===SolToBTCxSwapState.COMMITED) {
                const res = await this.contract.swapContract.getCommitStatus(swap.data);
                if(res===SwapCommitStatus.COMMITED) {
                    //Check if that maybe already concluded
                    try {
                        const refundAuth = await this.contract.getRefundAuthorization(swap.data, swap.url);
                        if(refundAuth!=null) {
                            if(!refundAuth.is_paid) {
                                swap.state = SolToBTCxSwapState.REFUNDABLE;
                                changedSwaps[paymentHash] = swap;
                            } else {
                                swap.secret = refundAuth.secret;
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
                if(res===SwapCommitStatus.NOT_COMMITED) {
                    swap.state = SolToBTCxSwapState.REFUNDED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.PAID) {
                    swap.state = SolToBTCxSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.EXPIRED) {
                    swap.state = SolToBTCxSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===SwapCommitStatus.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.REFUNDABLE;
                    changedSwaps[paymentHash] = swap;
                }
            }
        }

        for(let event of eventQueue) {
            await processEvent([event]);
        }

        eventQueue = null;

        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => changedSwaps[e]));

        this.isInitialized = true;

    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps(): Promise<ISolToBTCxSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: ISolToBTCxSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getOfferer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.state===SolToBTCxSwapState.REFUNDABLE) {
                returnArr.push(swap);
            }
        }

        return returnArr;

    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    getRefundableSwapsSync(): ISolToBTCxSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: ISolToBTCxSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getOfferer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.state===SolToBTCxSwapState.REFUNDABLE) {
                returnArr.push(swap);
            }
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<ISolToBTCxSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: ISolToBTCxSwap<T>[] = [];

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
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): ISolToBTCxSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: ISolToBTCxSwap<T>[] = [];

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
