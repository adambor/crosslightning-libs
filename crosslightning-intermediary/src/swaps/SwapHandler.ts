import {Express} from "express";
import {ISwapPrice} from "./ISwapPrice";
import {
    ChainEvents,
    ClaimEvent,
    InitializeEvent, RefundEvent,
    SwapContract,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {PluginManager} from "../plugins/PluginManager";
import {IIntermediaryStorage} from "../storage/IIntermediaryStorage";
import * as BN from "bn.js";
import {ServerParamEncoder} from "../utils/paramcoders/server/ServerParamEncoder";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    tokens: string[],
    data?: any,
};

export type SwapBaseConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    gracePeriod: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    swapCheckInterval: number
};

/**
 * An abstract class defining a singular swap service
 */
export abstract class SwapHandler<V extends SwapHandlerSwap<T, S>, T extends SwapData, S = any> {

    abstract readonly type: SwapHandlerType;

    readonly storageManager: IIntermediaryStorage<V>;
    readonly path: string;

    readonly swapContract: SwapContract<T, any, any, any>;
    readonly chainEvents: ChainEvents<T>;
    readonly allowedTokens: Set<string>;
    readonly swapPricing: ISwapPrice;
    readonly LND: AuthenticatedLnd;

    abstract config: SwapBaseConfig;

    logger = {
        debug: (msg, ...args) => console.debug("SwapHandler("+this.type+"): "+msg, ...args),
        info: (msg, ...args) => console.info("SwapHandler("+this.type+"): "+msg, ...args),
        warn: (msg, ...args) => console.warn("SwapHandler("+this.type+"): "+msg, ...args),
        error: (msg, ...args) => console.error("SwapHandler("+this.type+"): "+msg, ...args)
    };

    protected constructor(storageDirectory: IIntermediaryStorage<V>, path: string, swapContract: SwapContract<T, any, any, any>, chainEvents: ChainEvents<T>, allowedTokens: TokenAddress[], lnd: AuthenticatedLnd, swapPricing: ISwapPrice) {
        this.storageManager = storageDirectory;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.path = path;
        this.allowedTokens = new Set<string>(allowedTokens.map(e => e.toString()));
        this.LND = lnd;
        this.swapPricing = swapPricing;
    }

    protected abstract processPastSwaps(): Promise<void>;

    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.processPastSwaps().catch( e => console.error(e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    protected abstract processInitializeEvent(event: InitializeEvent<T>): Promise<void>;
    protected abstract processClaimEvent(event: ClaimEvent<T>): Promise<void>;
    protected abstract processRefundEvent(event: RefundEvent<T>): Promise<void>;

    /**
     * Chain event processor
     *
     * @param eventData
     */
    protected async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {
        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                await this.processInitializeEvent(event);
            } else if(event instanceof ClaimEvent) {
                await this.processClaimEvent(event);
            } else if(event instanceof RefundEvent) {
                await this.processRefundEvent(event);
            }
        }

        return true;
    }

    /**
     * Initializes chain events subscription
     */
    protected subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));
        this.logger.info("SC: Events: subscribed to smartchain events");
    }

    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    abstract init(): Promise<void>;

    /**
     * Sets up required listeners for the REST server
     *
     * @param restServer
     */
    abstract startRestServer(restServer: Express): void;

    /**
     * Returns swap handler info
     */
    abstract getInfo(): SwapHandlerInfoType;

    /**
     * Remove swap data
     *
     * @param hash
     * @param sequence
     */
    removeSwapData(hash: string, sequence: BN): Promise<void>;

    /**
     * Remove swap data
     *
     * @param swap
     * @param ultimateState set the ultimate state of the swap before removing
     */
    removeSwapData(swap: V, ultimateState?: S): Promise<void>;

    async removeSwapData(hashOrSwap: string | V, sequenceOrUltimateState?: BN | S) {
        let swap: V;
        if(typeof(hashOrSwap)==="string") {
            if(!BN.isBN(sequenceOrUltimateState)) throw new Error("Sequence must be a BN instance!");
            swap = await this.storageManager.getData(hashOrSwap, sequenceOrUltimateState);
        } else {
            swap = hashOrSwap;
            if(sequenceOrUltimateState!=null && !BN.isBN(sequenceOrUltimateState)) await swap.setState(sequenceOrUltimateState);
        }
        if(swap!=null) await PluginManager.swapRemove<T>(swap);
        this.logger.debug("removeSwapData(): removing swap payment hash: "+swap.getHash()+" sequence: "+swap.getSequence().toString(16)+" final state: "+swap.state);
        await this.storageManager.removeData(swap.getHash(), swap.getSequence());
    }

    /**
     * Creates an abort controller that extends the responseStream's abort signal
     *
     * @param responseStream
     */
    getAbortController(responseStream: ServerParamEncoder): AbortController {
        const abortController = new AbortController();
        const responseStreamAbortController = responseStream.getAbortSignal();
        responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));
        return abortController;
    }

    /**
     * Starts a pre-fetch for signature data
     *
     * @param abortController
     * @param responseStream
     */
    getSignDataPrefetch(abortController: AbortController, responseStream?: ServerParamEncoder): Promise<any> {
        let signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
            this.logger.error("getSignDataPrefetch(): signDataPrefetch: ", e);
            abortController.abort(e);
            return null;
        }) : null;

        if(signDataPrefetchPromise!=null && responseStream!=null) {
            signDataPrefetchPromise = signDataPrefetchPromise.then(val => val==null || abortController.signal.aborted ? null : responseStream.writeParams({
                signDataPrefetch: val
            }).then(() => val).catch(e => {
                this.logger.error("getSignDataPrefetch(): signDataPreFetch: error when sending sign data to the client: ", e);
                abortController.abort(e);
                return null;
            }));
            if(signDataPrefetchPromise!=null) this.logger.debug("getSignDataPrefetch(): pre-fetching signature data!");
        }

        return signDataPrefetchPromise;
    }

}
