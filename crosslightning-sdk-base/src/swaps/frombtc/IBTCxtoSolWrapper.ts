import {IBTCxtoSolSwap} from "./IBTCxtoSolSwap";
import {IWrapperStorage} from "../../storage/IWrapperStorage";
import {ClientSwapContract} from "../ClientSwapContract";
import * as EventEmitter from "events";
import {SwapData, ChainEvents} from "crosslightning-base";

export abstract class IBTCxtoSolWrapper<T extends SwapData> {

    readonly MAX_CONCURRENT_REQUESTS: number = 10;

    readonly storage: IWrapperStorage;
    readonly contract: ClientSwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    readonly swapDataDeserializer: new (data: any) => T;

    /**
     * Event emitter for all the swaps
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    swapData: {[paymentHash: string]: IBTCxtoSolSwap<T>};

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

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    abstract init(): Promise<void>;

    /**
     * Un-subscribes from event listeners on Solana
     */
    async stop() {
        this.swapData = null;
        this.isInitialized = false;
    }

    /**
     * Returns swaps that are claimable and that were initiated with the current provider's public key
     */
    abstract getClaimableSwaps(): Promise<IBTCxtoSolSwap<T>[]>;

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    abstract getAllSwaps(): Promise<IBTCxtoSolSwap<T>[]>;

}
