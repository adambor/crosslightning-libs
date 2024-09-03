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

    protected preFetchPrice(amountData: Omit<AmountData, "amount">, abortSignal?: AbortSignal): Promise<BN | null> {
        return this.prices.preFetchPrice(amountData.token, abortSignal).catch(e => {
            console.error(e);
            return null;
        });
    }

    protected preFetchIntermediaryReputation(
        amountData: Omit<AmountData, "amount">,
        lp: Intermediary,
        abortController: AbortController
    ): Promise<IntermediaryReputationType> {
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

    protected async verifyReturnedSignature(
        data: T,
        parsedData: {
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
                this.contract.isValidClaimInitAuthorization(data, parsedData.timeout, parsedData.prefix, parsedData.signature, feeRate, preFetchedSignatureData) :
                this.contract.isValidInitAuthorization(data, parsedData.timeout, parsedData.prefix, parsedData.signature, feeRate, preFetchedSignatureData),
            null,
            e => e instanceof SignatureVerificationError,
            abortSignal
        );
        return await tryWithRetries(
            () => data.isPayIn() ?
                this.contract.getClaimInitAuthorizationExpiry(data, parsedData.timeout, parsedData.prefix, parsedData.signature, preFetchedSignatureData) :
                this.contract.getInitAuthorizationExpiry(data, parsedData.timeout, parsedData.prefix, parsedData.signature, preFetchedSignatureData),
            null,
            e => e instanceof SignatureVerificationError,
            abortSignal
        );
    }

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