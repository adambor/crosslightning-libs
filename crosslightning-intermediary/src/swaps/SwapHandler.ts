import {Express, Request, Response} from "express";
import {ISwapPrice} from "./ISwapPrice";
import {
    AbstractSigner,
    ChainType,
    ClaimEvent,
    InitializeEvent, RefundEvent,
    SwapContract,
    SwapData,
    SwapEvent
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {PluginManager} from "../plugins/PluginManager";
import {IIntermediaryStorage} from "../storage/IIntermediaryStorage";
import * as BN from "bn.js";
import {ServerParamEncoder} from "../utils/paramcoders/server/ServerParamEncoder";
import {
    isQuoteAmountTooHigh,
    isQuoteAmountTooLow,
    isQuoteThrow,
} from "../plugins/IPlugin";
import {IParamReader} from "../utils/paramcoders/IParamReader";

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
    chainTokens: {[chainId: string]: string[]};
    data?: any,
};

export type SwapBaseConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    swapCheckInterval: number
};

export type MultichainData = {
    chains: {
        [identifier: string]: ChainData
    },
    default: string
};

export type ChainData<T extends ChainType = ChainType> = {
    signer: T["Signer"],
    swapContract: T["Contract"],
    chainEvents: T["Events"],
    allowedTokens: string[],
    btcRelay?: T["BtcRelay"]
}

export type RequestData<T> = {
    chainIdentifier: string,
    raw: Request & {paramReader: IParamReader},
    parsed: T,
    metadata: any
};

/**
 * An abstract class defining a singular swap service
 */
export abstract class SwapHandler<V extends SwapHandlerSwap<SwapData, S> = SwapHandlerSwap, S = any> {

    abstract readonly type: SwapHandlerType;

    readonly storageManager: IIntermediaryStorage<V>;
    readonly path: string;

    readonly chains: MultichainData;
    readonly allowedTokens: {[chainId: string]: Set<string>};
    readonly swapPricing: ISwapPrice;
    readonly LND: AuthenticatedLnd;

    abstract config: SwapBaseConfig;

    logger = {
        debug: (msg: string, ...args: any) => console.debug("SwapHandler("+this.type+"): "+msg, ...args),
        info: (msg: string, ...args: any) => console.info("SwapHandler("+this.type+"): "+msg, ...args),
        warn: (msg: string, ...args: any) => console.warn("SwapHandler("+this.type+"): "+msg, ...args),
        error: (msg: string, ...args: any) => console.error("SwapHandler("+this.type+"): "+msg, ...args)
    };

    protected swapLogger = {
        debug: (swap: SwapHandlerSwap | SwapEvent<SwapData> | SwapData, msg: string, ...args: any) => this.logger.debug(this.getIdentifier(swap)+": "+msg, ...args),
        info: (swap: SwapHandlerSwap | SwapEvent<SwapData> | SwapData, msg: string, ...args: any) => this.logger.info(this.getIdentifier(swap)+": "+msg, ...args),
        warn: (swap: SwapHandlerSwap | SwapEvent<SwapData> | SwapData, msg: string, ...args: any) => this.logger.warn(this.getIdentifier(swap)+": "+msg, ...args),
        error: (swap: SwapHandlerSwap | SwapEvent<SwapData> | SwapData, msg: string, ...args: any) => this.logger.error(this.getIdentifier(swap)+": "+msg, ...args)
    };

    protected constructor(
        storageDirectory: IIntermediaryStorage<V>,
        path: string,
        chainsData: MultichainData,
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice
    ) {
        this.storageManager = storageDirectory;
        this.chains = chainsData;
        if(this.chains.chains[this.chains.default]==null) throw new Error("Invalid default chain specified");
        this.path = path;
        this.LND = lnd;
        this.swapPricing = swapPricing;
        this.allowedTokens = {};
        for(let chainId in chainsData.chains) {
            this.allowedTokens[chainId] = new Set<string>(chainsData.chains[chainId].allowedTokens.map(e => e.toString()));
        }
    }

    protected getDefaultChain(): ChainData {
        return this.chains.chains[this.chains.default];
    }

    protected getChain(identifier: string): ChainData {
        if(this.chains.chains[identifier]==null)
            throw {
                code: 20200,
                msg: "Invalid chain specified!"
            };
        return this.chains.chains[identifier];
    }

    protected abstract processPastSwaps(): Promise<void>;

    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    async startWatchdog() {
        let rerun: () => Promise<void>;
        rerun = async () => {
            await this.processPastSwaps().catch( e => console.error(e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    protected abstract processInitializeEvent(chainIdentifier: string, event: InitializeEvent<SwapData>): Promise<void>;
    protected abstract processClaimEvent(chainIdentifier: string, event: ClaimEvent<SwapData>): Promise<void>;
    protected abstract processRefundEvent(chainIdentifier: string, event: RefundEvent<SwapData>): Promise<void>;

    /**
     * Chain event processor
     *
     * @param chainIdentifier
     * @param eventData
     */
    protected async processEvent(chainIdentifier: string, eventData: SwapEvent<SwapData>[]): Promise<boolean> {
        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                // this.swapLogger.debug(event, "SC: InitializeEvent: swap type: "+event.swapType);
                await this.processInitializeEvent(chainIdentifier, event);
            } else if(event instanceof ClaimEvent) {
                // this.swapLogger.debug(event, "SC: ClaimEvent: swap secret: "+event.secret);
                await this.processClaimEvent(chainIdentifier, event);
            } else if(event instanceof RefundEvent) {
                // this.swapLogger.debug(event, "SC: RefundEvent");
                await this.processRefundEvent(chainIdentifier, event);
            }
        }

        return true;
    }

    /**
     * Initializes chain events subscription
     */
    protected subscribeToEvents() {
        for(let key in this.chains.chains) {
            this.chains.chains[key].chainEvents.registerListener((events: SwapEvent<SwapData>[]) => this.processEvent(key, events));
        }
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
     * Returns data to be returned in swap handler info
     */
    abstract getInfoData(): any;

    /**
     * Remove swap data
     *
     * @param hash
     * @param sequence
     */
    protected removeSwapData(hash: string, sequence: BN): Promise<void>;

    /**
     * Remove swap data
     *
     * @param swap
     * @param ultimateState set the ultimate state of the swap before removing
     */
    protected removeSwapData(swap: V, ultimateState?: S): Promise<void>;

    protected async removeSwapData(hashOrSwap: string | V, sequenceOrUltimateState?: BN | S) {
        let swap: V;
        if(typeof(hashOrSwap)==="string") {
            if(!BN.isBN(sequenceOrUltimateState)) throw new Error("Sequence must be a BN instance!");
            swap = await this.storageManager.getData(hashOrSwap, sequenceOrUltimateState);
        } else {
            swap = hashOrSwap;
            if(sequenceOrUltimateState!=null && !BN.isBN(sequenceOrUltimateState)) await swap.setState(sequenceOrUltimateState);
        }
        if(swap!=null) await PluginManager.swapRemove(swap);
        this.swapLogger.debug(swap, "removeSwapData(): removing swap final state: "+swap.state);
        await this.storageManager.removeData(swap.getHash(), swap.getSequence());
    }

    /**
     * Checks whether the bitcoin amount is within specified min/max bounds
     *
     * @param amount
     * @protected
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    protected checkBtcAmountInBounds(amount: BN): void {
        if (amount.lt(this.config.min)) {
            throw {
                code: 20003,
                msg: "Amount too low!",
                data: {
                    min: this.config.min.toString(10),
                    max: this.config.max.toString(10)
                }
            };
        }

        if(amount.gt(this.config.max)) {
            throw {
                code: 20004,
                msg: "Amount too high!",
                data: {
                    min: this.config.min.toString(10),
                    max: this.config.max.toString(10)
                }
            };
        }
    }

    /**
     * Handles and throws plugin errors
     *
     * @param res Response as returned from the PluginManager.onHandlePost{To,From}BtcQuote
     * @protected
     * @throws {DefinedRuntimeError} will throw an error if the response is an error
     */
    protected handlePluginErrorResponses(res: any): void {
        if(isQuoteThrow(res)) throw {
            code: 29999,
            msg: res.message
        };
        if(isQuoteAmountTooHigh(res)) throw {
            code: 20004,
            msg: "Amount too high!",
            data: {
                min: res.data.min.toString(10),
                max: res.data.max.toString(10)
            }
        };
        if(isQuoteAmountTooLow(res)) throw {
            code: 20003,
            msg: "Amount too low!",
            data: {
                min: res.data.min.toString(10),
                max: res.data.max.toString(10)
            }
        };
    }

    /**
     * Creates an abort controller that extends the responseStream's abort signal
     *
     * @param responseStream
     */
    protected getAbortController(responseStream: ServerParamEncoder): AbortController {
        const abortController = new AbortController();
        const responseStreamAbortController = responseStream.getAbortSignal();
        responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));
        return abortController;
    }

    /**
     * Starts a pre-fetch for signature data
     *
     * @param chainIdentifier
     * @param abortController
     * @param responseStream
     */
    protected getSignDataPrefetch(chainIdentifier: string, abortController: AbortController, responseStream?: ServerParamEncoder): Promise<any> {
        const {swapContract} = this.getChain(chainIdentifier);
        let signDataPrefetchPromise: Promise<any> = swapContract.preFetchBlockDataForSignatures!=null ? swapContract.preFetchBlockDataForSignatures().catch(e => {
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
        }

        return signDataPrefetchPromise;
    }

    protected getIdentifierFromEvent(event: SwapEvent<SwapData>): string {
        if(event.sequence.isZero()) return event.paymentHash;
        return event.paymentHash+"_"+event.sequence.toString(16);
    }

    protected getIdentifierFromSwapData(swapData: SwapData): string {
        if(swapData.getSequence().isZero()) return swapData.getHash();
        return swapData.getHash()+"_"+swapData.getSequence().toString(16);
    }

    protected getIdentifier(swap: SwapHandlerSwap | SwapEvent<SwapData> | SwapData) {
        if(swap instanceof SwapHandlerSwap) {
            return swap.getIdentifier();
        }
        if(swap instanceof SwapEvent) {
            return this.getIdentifierFromEvent(swap);
        }
        return this.getIdentifierFromSwapData(swap);
    }

    /**
     * Checks if the sequence number is between 0-2^64
     *
     * @param sequence
     * @throws {DefinedRuntimeError} will throw an error if sequence number is out of bounds
     */
    protected checkSequence(sequence: BN) {
        if(sequence.isNeg() || sequence.gte(new BN(2).pow(new BN(64)))) {
            throw {
                code: 20060,
                msg: "Invalid sequence"
            };
        }
    }

    /**
     * Checks whether a given token is supported on a specified chain
     *
     * @param chainId
     * @param token
     * @protected
     */
    protected isTokenSupported(chainId: string, token: string): boolean {
        const chainTokens = this.allowedTokens[chainId];
        if(chainTokens==null) return false;
        return chainTokens.has(token);
    }

    getInfo(): SwapHandlerInfoType {
        const chainTokens: {[chainId: string]: string[]} = {};
        for(let chainId in this.allowedTokens) {
            chainTokens[chainId] = Array.from<string>(this.allowedTokens[chainId]);
        }
        return {
            swapFeePPM: this.config.feePPM.toNumber(),
            swapBaseFee: this.config.baseFee.toNumber(),
            min: this.config.min.toNumber(),
            max: this.config.max.toNumber(),
            data: this.getInfoData(),
            tokens: Array.from<string>(this.allowedTokens[this.chains.default]),
            chainTokens
        };
    }

}
