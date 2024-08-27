import {IFromBTCSwap} from "./IFromBTCSwap";
import {IWrapperStorage} from "../../storage/IWrapperStorage";
import {ClientSwapContract} from "../ClientSwapContract";
import {EventEmitter} from "events";
import {SwapData, ChainEvents} from "crosslightning-base";

export abstract class IFromBTCWrapper<T extends SwapData> {

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

    swapData: {[paymentHash: string]: IFromBTCSwap<T>};

    isInitialized: boolean = false;

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param events                    Instance to use for emitting events
     */
    protected constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T, events?: EventEmitter) {
        this.storage = storage;
        this.contract = contract;
        this.chainEvents = chainEvents;
        this.swapDataDeserializer = swapDataDeserializer;
        this.events = events || new EventEmitter();
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
    abstract getClaimableSwaps(): Promise<IFromBTCSwap<T>[]>;

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    abstract getAllSwaps(): Promise<IFromBTCSwap<T>[]>;

}
