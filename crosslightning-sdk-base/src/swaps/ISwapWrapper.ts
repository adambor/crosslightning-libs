import {ClientSwapContract} from "./ClientSwapContract";
import {
    ChainEvents,
    ClaimEvent,
    InitializeEvent,
    IStorageManager,
    RefundEvent,
    SwapData,
    SwapEvent
} from "crosslightning-base";
import {EventEmitter} from "events";
import {ISwap} from "./ISwap";
import {SwapWrapperStorage} from "./SwapWrapperStorage";

export abstract class ISwapWrapper<T extends SwapData, S extends ISwap<T>> {

    protected readonly abstract swapDeserializer: new (wrapper: ISwapWrapper<T, S>, data: any) => S;

    readonly storage: SwapWrapperStorage<S>;
    readonly contract: ClientSwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    readonly swapDataDeserializer: new (data: any) => T;
    readonly events: EventEmitter<{
        swapState: [S]
    }>;

    swapData: {[paymentHash: string]: S};
    isInitialized: boolean = false;

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param events                    Instance to use for emitting events
     */
    constructor(
        storage: IStorageManager<S>,
        contract: ClientSwapContract<T>,
        chainEvents: ChainEvents<T>,
        swapDataDeserializer: new (data: any) => T,
        events?: EventEmitter<{swapState: [S]}>
    ) {
        this.storage = new SwapWrapperStorage<S>(storage);
        this.contract = contract;
        this.chainEvents = chainEvents;
        this.swapDataDeserializer = swapDataDeserializer;
        this.events = events || new EventEmitter();
    }

    protected abstract isOurSwap(swap: S): boolean;
    protected abstract processEventInitialize(swap: S, event: InitializeEvent<T>): Promise<boolean>;
    protected abstract processEventClaim(swap: S, event: ClaimEvent<T>): Promise<boolean>;
    protected abstract processEventRefund(swap: S, event: RefundEvent<T>): Promise<boolean>;

    protected abstract checkPastSwap(swap: S): Promise<boolean>;

    private async processEvents(events: SwapEvent<T>[]): Promise<boolean> {
        for(let event of events) {
            const paymentHash = event.paymentHash;
            const swap: S = this.swapData[paymentHash];
            if(swap==null) continue;

            let swapChanged: boolean = false;
            if(event instanceof InitializeEvent) swapChanged = await this.processEventInitialize(swap, event);
            if(event instanceof ClaimEvent) swapChanged = await this.processEventClaim(swap, event);
            if(event instanceof RefundEvent) swapChanged = await this.processEventRefund(swap, event);

            if(swapChanged) {
                await (swap.isQuoteExpired() ? this.storage.removeSwapData(swap) : swap._save());
                swap._emitEvent();
            }
        }
        return true;
    }

    public async init(): Promise<void> {
        await this.storage.init();
        if(this.isInitialized) return;
        this.swapData = await this.storage.loadSwapData(this, this.swapDeserializer);

        //Save events received in the meantime into the event queue and process them only after we've checked and
        // processed all the past swaps
        let eventQueue: SwapEvent<T>[] = [];
        const initListener = (events: SwapEvent<T>[]) => {
            eventQueue.push(...eventQueue);
            return Promise.resolve(true);
        }
        this.chainEvents.registerListener(initListener);

        //Check past swaps
        const changedSwaps: S[] = [];
        const removeSwaps: S[] = [];

        await Promise.all(
            Object.keys(this.swapData)
                .map(paymentHash => this.swapData[paymentHash])
                .map(swap => this.checkPastSwap(swap).then(changed => {
                    if(swap.isQuoteExpired()) {
                        removeSwaps.push(swap);
                    } else {
                        if(changed) changedSwaps.push(swap);
                    }
                }))
        );

        await this.storage.removeSwapDataArr(removeSwaps);
        await this.storage.saveSwapDataArr(changedSwaps);

        //Process accumulated event queue
        await this.processEvents(eventQueue);

        //Register the correct event handler
        this.chainEvents.unregisterListener(initListener);
        this.chainEvents.registerListener(this.processEvents);

        this.isInitialized = true;
    }

    /**
     * Un-subscribes from event listeners on Solana
     */
    public async stop() {
        this.swapData = null;
        this.isInitialized = false;
        this.chainEvents.unregisterListener(this.processEvents);
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    public getAllSwaps(): Promise<S[]> {
        return Promise.resolve(this.getAllSwapsSync());
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    public getAllSwapsSync(): S[] {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        return Object.keys(this.swapData)
            .map(paymentHash => this.swapData[paymentHash])
            .filter(this.isOurSwap);
    }

}