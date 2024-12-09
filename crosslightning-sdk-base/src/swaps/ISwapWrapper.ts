import {
    ChainType,
    ClaimEvent,
    InitializeEvent,
    IStorageManager,
    RefundEvent, SignatureData,
    SignatureVerificationError,
    SwapEvent
} from "crosslightning-base";
import {EventEmitter} from "events";
import {ISwap} from "./ISwap";
import {SwapWrapperStorage} from "./SwapWrapperStorage";
import {ISwapPrice, PriceInfoType} from "../prices/abstract/ISwapPrice";
import * as BN from "bn.js";
import {IntermediaryError} from "../errors/IntermediaryError";
import {getLogger, mapToArray, tryWithRetries} from "../utils/Utils";
import {SCToken} from "./Tokens";
import {ChainIds, MultiChain} from "./Swapper";

export type AmountData = {
    amount: BN,
    token: string,
    exactIn?: boolean
}

export type ISwapWrapperOptions = {
    getRequestTimeout?: number,
    postRequestTimeout?: number
};

export type WrapperCtorTokens<T extends MultiChain = MultiChain> = {
    ticker: string,
    name: string,
    chains: {[chainId in ChainIds<T>]?: {
        address: string,
        decimals: number
    }}
}[];

export abstract class ISwapWrapper<
    T extends ChainType,
    S extends ISwap<T>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> {
    protected readonly logger = getLogger(this.constructor.name+": ");

    protected readonly abstract swapDeserializer: new (wrapper: ISwapWrapper<T, S, O>, data: any) => S;

    readonly chainIdentifier: string;
    readonly storage: SwapWrapperStorage<S>;
    readonly contract: T["Contract"];
    readonly prices: ISwapPrice;
    readonly chainEvents: T["Events"];
    readonly swapDataDeserializer: new (data: any) => T["Data"];
    readonly events: EventEmitter;
    readonly options: O;
    readonly tokens: {
        [tokenAddress: string]: SCToken<T["ChainId"]>
    };

    swapData: Map<string, S>;
    isInitialized: boolean = false;
    tickInterval: NodeJS.Timeout = null;

    /**
     * @param chainIdentifier
     * @param storage Storage interface for the current environment
     * @param contract Underlying contract handling the swaps
     * @param prices Swap pricing handler
     * @param chainEvents On-chain event listener
     * @param tokens Chain specific token data
     * @param swapDataDeserializer Deserializer for SwapData
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        chainIdentifier: string,
        storage: IStorageManager<S>,
        contract: T["Contract"],
        chainEvents: T["Events"],
        prices: ISwapPrice,
        tokens: WrapperCtorTokens,
        swapDataDeserializer: new (data: any) => T["Data"],
        options: O,
        events?: EventEmitter
    ) {
        this.chainIdentifier = chainIdentifier;
        this.storage = new SwapWrapperStorage<S>(storage);
        this.contract = contract;
        this.prices = prices;
        this.chainEvents = chainEvents;
        this.swapDataDeserializer = swapDataDeserializer;
        this.events = events || new EventEmitter();
        this.options = options;
        this.tokens = {};
        for(let tokenData of tokens) {
            const chainData = tokenData.chains[chainIdentifier];
            if(chainData==null) continue;
            this.tokens[chainData.address] = {
                chain: "SC",
                chainId: this.chainIdentifier,
                address: chainData.address,
                decimals: chainData.decimals,
                ticker: tokenData.ticker,
                name: tokenData.name
            };
        }
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
        return this.prices.preFetchPrice(this.chainIdentifier, amountData.token, abortSignal).catch(e => {
            this.logger.error("preFetchPrice(): Error: ", e);
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
            this.logger.error("preFetchSignData(): Error: ", e);
            return null;
        });
    }

    /**
     * Verifies swap initialization signature returned by the intermediary
     *
     * @param data Parsed swap data from the intermediary
     * @param signature Response of the intermediary
     * @param feeRatePromise Pre-fetched fee rate promise
     * @param preFetchSignatureVerificationData Pre-fetched signature verification data
     * @param abortSignal
     * @protected
     * @returns Swap initialization signature expiry
     * @throws {SignatureVerificationError} when swap init signature is invalid
     */
    protected async verifyReturnedSignature(
        data: T["Data"],
        signature: SignatureData,
        feeRatePromise: Promise<any>,
        preFetchSignatureVerificationData: Promise<any>,
        abortSignal?: AbortSignal
    ): Promise<number> {
        const [feeRate, preFetchedSignatureData] = await Promise.all([feeRatePromise, preFetchSignatureVerificationData]);
        await tryWithRetries(
            () => this.contract.isValidInitAuthorization(data, signature, feeRate, preFetchedSignatureData),
            null,
            SignatureVerificationError,
            abortSignal
        );
        return await tryWithRetries(
            () => this.contract.getInitAuthorizationExpiry(data, signature, preFetchedSignatureData),
            null,
            SignatureVerificationError,
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
        lpServiceData: {swapBaseFee: number, swapFeePPM: number},
        send: boolean,
        amountSats: BN,
        amountToken: BN,
        token: string,
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
                this.prices.isValidAmountSend(this.chainIdentifier, amountSats, swapBaseFee, swapFeePPM, amountToken, token, abortSignal, await pricePrefetchPromise) :
                this.prices.isValidAmountReceive(this.chainIdentifier, amountSats, swapBaseFee, swapFeePPM, amountToken, token, abortSignal, await pricePrefetchPromise)
        );
        if(!isValidAmount.isValid) throw new IntermediaryError("Fee too high");

        return isValidAmount;
    }

    /**
     * Checks if the provided swap is belonging to the provided signer's address
     *
     * @param signer
     * @param swap Swap to be checked
     * @protected
     */
    protected abstract isOurSwap(signer: string, swap: S): boolean;

    /**
     * Processes InitializeEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected processEventInitialize?(swap: S, event: InitializeEvent<T["Data"]>): Promise<boolean>;

    /**
     * Processes ClaimEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected processEventClaim?(swap: S, event: ClaimEvent<T["Data"]>): Promise<boolean>;

    /**
     * Processes RefundEvent for a given swap
     * @param swap
     * @param event
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected processEventRefund?(swap: S, event: RefundEvent<T["Data"]>): Promise<boolean>;

    /**
     * Checks past swap and syncs its state from the chain, this is called on initialization for all unfinished swaps
     * @param swap
     * @protected
     * @returns Whether the swap was updated/changed
     */
    protected abstract checkPastSwap(swap: S): Promise<boolean>;

    protected abstract tickSwap(swap: S): void;

    /**
     * Processes batch of SC on-chain events
     * @param events
     * @private
     */
    private async processEvents(events: SwapEvent<T["Data"]>[]): Promise<boolean> {
        for(let event of events) {
            const paymentHash = event.paymentHash;
            const swap: S = this.swapData.get(paymentHash);
            if(swap==null) continue;

            let swapChanged: boolean = false;
            if(event instanceof InitializeEvent) {
                swapChanged = await this.processEventInitialize(swap, event);
                if(event.meta?.txId!=null && swap.commitTxId!==event.meta.txId) {
                    swap.commitTxId = event.meta.txId;
                    swapChanged ||= true;
                }
            }
            if(event instanceof ClaimEvent) {
                swapChanged = await this.processEventClaim(swap, event);
                if(event.meta?.txId!=null && swap.claimTxId!==event.meta.txId) {
                    swap.claimTxId = event.meta.txId;
                    swapChanged ||= true;
                }
            }
            if(event instanceof RefundEvent) {
                swapChanged = await this.processEventRefund(swap, event);
                if(event.meta?.txId!=null && swap.refundTxId!==event.meta.txId) {
                    swap.refundTxId = event.meta.txId;
                    swapChanged ||= true;
                }
            }

            this.logger.info("processEvents(): "+event.constructor.name+" processed for "+swap.getPaymentHashString()+" swap: ", swap);

            if(swapChanged) {
                await swap._saveAndEmit();
            }
        }
        return true;
    }
    private boundProcessEvents = this.processEvents.bind(this);

    /**
     * Initializes the swap wrapper, needs to be called before any other action can be taken
     */
    public async init(): Promise<void> {
        await this.storage.init();
        if(this.isInitialized) return;
        this.swapData = await this.storage.loadSwapData(this, this.swapDeserializer);

        const hasEventListener = this.processEventRefund!=null || this.processEventClaim!=null || this.processEventInitialize!=null;

        //Save events received in the meantime into the event queue and process them only after we've checked and
        // processed all the past swaps
        let eventQueue: SwapEvent<T["Data"]>[] = [];
        const initListener = (events: SwapEvent<T["Data"]>[]) => {
            eventQueue.push(...events);
            return Promise.resolve(true);
        }
        if(hasEventListener) this.chainEvents.registerListener(initListener);

        //Check past swaps
        const changedSwaps: S[] = [];
        const removeSwaps: S[] = [];

        await Promise.all(
            mapToArray(this.swapData, (key: string, swap: S) =>
                this.checkPastSwap(swap).then(changed => {
                    if(swap.isQuoteExpired()) {
                        removeSwaps.push(swap);
                    } else {
                        if(changed) changedSwaps.push(swap);
                    }
                }).catch(e => this.logger.error("init(): Error when checking swap "+swap.getPaymentHashString()+": ", e))
            )
        );

        await this.storage.removeSwapDataArr(removeSwaps);
        await this.storage.saveSwapDataArr(changedSwaps);

        if(hasEventListener) {
            //Process accumulated event queue
            await this.processEvents(eventQueue);

            //Register the correct event handler
            this.chainEvents.unregisterListener(initListener);
            this.chainEvents.registerListener(this.boundProcessEvents);
        }

        this.tickInterval = setInterval(() => {
            this.swapData.forEach(value => {
                this.tickSwap(value);
            })
        }, 1000);

        this.logger.info("init(): Swap wrapper initialized, num swaps: "+this.swapData.size);

        this.isInitialized = true;
    }

    /**
     * Un-subscribes from event listeners on Solana
     */
    public async stop() {
        this.swapData = null;
        this.isInitialized = false;
        this.chainEvents.unregisterListener(this.boundProcessEvents);
        this.logger.info("stop(): Swap wrapper stopped");
        if(this.tickInterval!=null) clearInterval(this.tickInterval);
    }

    /**
     * Returns all swaps, optionally only those which were intiated by as specific signer's address
     */
    public getAllSwaps(signer?: string): Promise<S[]> {
        return Promise.resolve(this.getAllSwapsSync(signer));
    }

    /**
     * Returns all swaps, optionally only those which were intiated by as specific signer's address
     */
    public getAllSwapsSync(signer?: string): S[] {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const array = mapToArray(this.swapData, (key, value: S) => value);
        if(signer!=null) return array.filter((swap) => this.isOurSwap(signer, swap));
        return array;
    }

}