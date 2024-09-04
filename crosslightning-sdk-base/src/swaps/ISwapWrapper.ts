import {
    ChainEvents,
    ClaimEvent,
    InitializeEvent,
    IntermediaryReputationType,
    IStorageManager,
    RefundEvent,
    SignatureVerificationError,
    SwapContract,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {EventEmitter} from "events";
import {ISwap} from "./ISwap";
import {SwapWrapperStorage} from "./SwapWrapperStorage";
import {ISwapPrice, PriceInfoType} from "../prices/abstract/ISwapPrice";
import * as BN from "bn.js";
import {Intermediary} from "../intermediaries/Intermediary";
import {IntermediaryError} from "../errors/IntermediaryError";
import {SwapHandlerInfoType} from "../intermediaries/IntermediaryDiscovery";
import {tryWithRetries} from "../utils/Utils";

export type AmountData = {
    amount: BN,
    token: TokenAddress,
    exactIn?: boolean
}

export type ISwapWrapperOptions = {
    getRequestTimeout?: number,
    postRequestTimeout?: number
};

export abstract class ISwapWrapper<
    T extends SwapData,
    S extends ISwap<T>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> {

    protected readonly abstract swapDeserializer: new (wrapper: ISwapWrapper<T, S, O>, data: any) => S;

    readonly storage: SwapWrapperStorage<S>;
    readonly contract: SwapContract<T, any, any, any>;
    readonly prices: ISwapPrice;
    readonly chainEvents: ChainEvents<T>;
    readonly swapDataDeserializer: new (data: any) => T;
    readonly events: EventEmitter<{
        swapState: [S]
    }>;
    readonly options: O;

    swapData: {[paymentHash: string]: S};
    isInitialized: boolean = false;

    /**
     * @param storage Storage interface for the current environment
     * @param contract Underlying contract handling the swaps
     * @param prices Swap pricing handler
     * @param chainEvents On-chain event listener
     * @param swapDataDeserializer Deserializer for SwapData
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        storage: IStorageManager<S>,
        contract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        prices: ISwapPrice,
        swapDataDeserializer: new (data: any) => T,
        options: O,
        events?: EventEmitter<{swapState: [S]}>
    ) {
        this.storage = new SwapWrapperStorage<S>(storage);
        this.contract = contract;
        this.prices = prices;
        this.chainEvents = chainEvents;
        this.swapDataDeserializer = swapDataDeserializer;
        this.events = events || new EventEmitter();
        this.options = options;
    }

    /**
     * Pre-fetches swap price for a given swap
     *
     * @param amountData
     * @param abortSignal
     * @protected
     * @returns Price of the token in uSats (micro sats)
     */
    protected preFetchPrice(amountData: Omit<AmountData, "amount">, abortSignal?: AbortSignal): Promise<BN | null> {
        return this.prices.preFetchPrice(amountData.token, abortSignal).catch(e => {
            console.error(e);
            return null;
        });
    }

    /**
     * Pre-fetches intermediary's reputation, doesn't throw, instead aborts via abortController and returns null
     *
     * @param amountData
     * @param lp Intermediary
     * @param abortController
     * @protected
     * @returns Intermediary's reputation or null if failed
     */
    protected preFetchIntermediaryReputation(
        amountData: Omit<AmountData, "amount">,
        lp: Intermediary,
        abortController: AbortController
    ): Promise<IntermediaryReputationType | null> {
        return tryWithRetries(
            () => this.contract.getIntermediaryReputation(lp.address, amountData.token),
            null, null, abortController.signal
        ).then(res => {
            if(res==null) throw new IntermediaryError("Invalid data returned - invalid LP vault");
            return res;
        }).catch(e => {
            console.error(e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Pre-fetches signature verification data from the server's pre-sent promise, doesn't throw, instead returns null
     *
     * @param signDataPrefetch Promise that resolves when we receive "signDataPrefetch" from the LP in streaming mode
     * @protected
     * @returns Pre-fetched signature verification data or null if failed
     */
    protected preFetchSignData(signDataPrefetch: Promise<any | null>): Promise<any | null> {
        if(this.contract.preFetchForInitSignatureVerification==null) return Promise.resolve(null);
        return signDataPrefetch.then(obj => {
            if(obj==null) return null;
            return this.contract.preFetchForInitSignatureVerification(obj);
        }).catch(e => {
            console.error(e);
            return null;
        });
    }

    /**
     * Verifies swap initialization signature returned by the intermediary
     *
     * @param data Parsed swap data from the intermediary
     * @param signatureData Response of the intermediary
     * @param feeRatePromise Pre-fetched fee rate promise
     * @param preFetchSignatureVerificationData Pre-fetched signature verification data
     * @param abortSignal
     * @protected
     * @returns Swap initialization signature expiry
     * @throws {SignatureVerificationError} when swap init signature is invalid
     */
    protected async verifyReturnedSignature(
        data: T,
        {timeout, prefix, signature}: {
            timeout: string,
            prefix: string,
            signature: string
        },
        feeRatePromise: Promise<any>,
        preFetchSignatureVerificationData: Promise<any>,
        abortSignal?: AbortSignal
    ): Promise<number> {
        const [feeRate, preFetchedSignatureData] = await Promise.all([feeRatePromise, preFetchSignatureVerificationData]);
        await tryWithRetries(
            () => data.isPayIn() ?
                this.contract.isValidClaimInitAuthorization(data, timeout, prefix, signature, feeRate, preFetchedSignatureData) :
                this.contract.isValidInitAuthorization(data, timeout, prefix, signature, feeRate, preFetchedSignatureData),
            null,
            e => e instanceof SignatureVerificationError,
            abortSignal
        );
        return await tryWithRetries(
            () => data.isPayIn() ?
                this.contract.getClaimInitAuthorizationExpiry(data, timeout, prefix, signature, preFetchedSignatureData) :
                this.contract.getInitAuthorizationExpiry(data, timeout, prefix, signature, preFetchedSignatureData),
            null,
            e => e instanceof SignatureVerificationError,
            abortSignal
        );
    }

    /**
     * Verifies returned  price for swaps
     *
     * @param lpServiceData Service data for the service in question (TO_BTCLN, TO_BTC, etc.) of the given intermediary
     * @param send Whether this is a send (SOL -> SC) or receive (BTC -> SC) swap
     * @param amountSats Amount in BTC
     * @param amountToken Amount in token
     * @param token Token used in the swap
     * @param feeData Fee data as returned by the intermediary
     * @param pricePrefetchPromise Price pre-fetch promise
     * @param abortSignal
     * @protected
     * @returns Price info object
     * @throws {IntermediaryError} if the calculated fee is too high
     */
    protected async verifyReturnedPrice(
        lpServiceData: SwapHandlerInfoType,
        send: boolean,
        amountSats: BN,
        amountToken: BN,
        token: TokenAddress,
        feeData: {
            swapFee: BN,
            networkFee?: BN,
            totalFee?: BN
        },
        pricePrefetchPromise: Promise<BN> = Promise.resolve(null),
        abortSignal?: AbortSignal
    ): Promise<PriceInfoType> {
        const swapBaseFee = new BN(lpServiceData.swapBaseFee);
        const swapFeePPM = new BN(lpServiceData.swapFeePPM);
        if(send) amountToken = amountToken.sub(feeData.networkFee);

        const isValidAmount = await (
            send ?
                this.prices.isValidAmountSend :
                this.prices.isValidAmountReceive
        )(amountSats, swapBaseFee, swapFeePPM, amountToken, token, abortSignal, await pricePrefetchPromise);
        if(!isValidAmount.isValid) throw new IntermediaryError("Fee too high");

        return isValidAmount;
    }

    /**
     * Checks if the provided swap is "ours", belonging to the underlying provider's address/public key
     * @param swap Swap to be checked
     * @protected
     */
    protected abstract isOurSwap(swap: S): boolean;

    /**
     * Processes InitializeEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected abstract processEventInitialize(swap: S, event: InitializeEvent<T>): Promise<boolean>;

    /**
     * Processes ClaimEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected abstract processEventClaim(swap: S, event: ClaimEvent<T>): Promise<boolean>;

    /**
     * Processes RefundEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected abstract processEventRefund(swap: S, event: RefundEvent<T>): Promise<boolean>;

    /**
     * Checks past swap and syncs its state from the chain, this is called on initialization for all unfinished swaps
     * @param swap
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected abstract checkPastSwap(swap: S): Promise<boolean>;

    /**
     * Processes batch of SC on-chain events
     * @param events
     * @private
     */
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

    /**
     * Initializes the swap wrapper, needs to be called before any other action can be taken
     */
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
                }).catch(e => console.error(e)))
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