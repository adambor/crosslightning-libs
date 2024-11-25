import {BitcoinNetwork} from "../btc/BitcoinNetwork";
import {ISwapPrice} from "../prices/abstract/ISwapPrice";
import {
    ChainType,
    IStorageManager
} from "crosslightning-base";
import {ToBTCLNWrapper} from "./tobtc/ln/ToBTCLNWrapper";
import {ToBTCWrapper} from "./tobtc/onchain/ToBTCWrapper";
import {FromBTCLNWrapper} from "./frombtc/ln/FromBTCLNWrapper";
import {FromBTCWrapper} from "./frombtc/onchain/FromBTCWrapper";
import {IntermediaryDiscovery, MultichainSwapBounds, SwapBounds} from "../intermediaries/IntermediaryDiscovery";
import {address, Network, networks} from "bitcoinjs-lib";
import {decode as bolt11Decode} from "bolt11";
import * as BN from "bn.js";
import {IFromBTCSwap} from "./frombtc/IFromBTCSwap";
import {IToBTCSwap} from "./tobtc/IToBTCSwap";
import {ISwap} from "./ISwap";
import {IntermediaryError} from "../errors/IntermediaryError";
import {SwapType} from "./SwapType";
import {FromBTCLNSwap} from "./frombtc/ln/FromBTCLNSwap";
import {FromBTCSwap} from "./frombtc/onchain/FromBTCSwap";
import {ToBTCLNSwap} from "./tobtc/ln/ToBTCLNSwap";
import {ToBTCSwap} from "./tobtc/onchain/ToBTCSwap";
import {MempoolApi} from "../btc/mempool/MempoolApi";
import {MempoolBitcoinRpc} from "../btc/mempool/MempoolBitcoinRpc";
import {BtcRelay, RelaySynchronizer} from "crosslightning-base/dist";
import {MempoolBtcRelaySynchronizer} from "../btc/mempool/synchronizer/MempoolBtcRelaySynchronizer";
import {LnForGasWrapper} from "./swapforgas/ln/LnForGasWrapper";
import {LnForGasSwap} from "./swapforgas/ln/LnForGasSwap";
import {EventEmitter} from "events";
import {Buffer} from "buffer";
import {IndexedDBStorageManager} from "../storage/IndexedDBStorageManager";
import {MempoolBitcoinBlock} from "../btc/mempool/MempoolBitcoinBlock";
import {LocalStorageManager} from "../storage/LocalStorageManager";
import {Intermediary} from "../intermediaries/Intermediary";
import {isLNURLPay, isLNURLWithdraw, isLNURLWithdrawParams, LNURL, LNURLPay, LNURLWithdraw} from "../utils/LNURL";
import {AmountData, WrapperCtorTokens} from "./ISwapWrapper";
import {getLogger, objectMap} from "../utils/Utils";
import {OutOfBoundsError} from "../errors/RequestError";
import {SwapperWithChain} from "./SwapperWithChain";
import {BtcToken, SCToken, Token} from "./Tokens";

export type SwapperOptions = {
    intermediaryUrl?: string | string[],
    registryUrl?: string,

    bitcoinNetwork?: BitcoinNetwork,

    getRequestTimeout?: number,
    postRequestTimeout?: number,
    defaultAdditionalParameters?: {[key: string]: any},
    storagePrefix?: string
};

export type MultiChain = {
    [chainIdentifier in string]: ChainType;
};

export type ChainSpecificData<T extends ChainType> = {
    tobtcln: ToBTCLNWrapper<T>,
    tobtc: ToBTCWrapper<T>,
    frombtcln: FromBTCLNWrapper<T>,
    frombtc: FromBTCWrapper<T>,
    lnforgas: LnForGasWrapper<T>,
    chainEvents: T["Events"],
    swapContract: T["Contract"],
    btcRelay: BtcRelay<any, T["TX"], MempoolBitcoinBlock, T["Signer"]>,
    synchronizer: RelaySynchronizer<any, T["TX"], MempoolBitcoinBlock>,
    defaultTrustedIntermediaryUrl?: string
};

export type MultiChainData<T extends MultiChain> = {
    [chainIdentifier in keyof T]: ChainSpecificData<T[chainIdentifier]>
};

export type CtorChainData<T extends ChainType> = {
    btcRelay: BtcRelay<any, T["TX"], MempoolBitcoinBlock>,
    swapContract: T["Contract"],
    chainEvents: T["Events"],
    swapDataConstructor: new (data: any) => T["Data"],
    storage?: {
        toBtc?: IStorageManager<ToBTCSwap<T>>,
        fromBtc?: IStorageManager<FromBTCSwap<T>>,
        toBtcLn?: IStorageManager<ToBTCLNSwap<T>>,
        fromBtcLn?: IStorageManager<FromBTCLNSwap<T>>,
        lnForGas?: IStorageManager<LnForGasSwap<T>>
    },
    defaultTrustedIntermediaryUrl?: string
};

export type CtorMultiChainData<T extends MultiChain> = {
    [chainIdentifier in keyof T]: CtorChainData<T[chainIdentifier]>
};

export type ChainIds<T extends MultiChain> = keyof T & string;

export interface SwapperBtcUtils {
    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param addr
     */
    isValidBitcoinAddress(addr: string): boolean;

    /**
     * Returns true if string is a valid BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    isValidLightningInvoice(lnpr: string): boolean;

    /**
     * Returns true if string is a valid LNURL (no checking on type is performed)
     *
     * @param lnurl
     */
    isValidLNURL(lnurl: string): boolean;

    /**
     * Returns type and data about an LNURL
     *
     * @param lnurl
     * @param shouldRetry
     */
    getLNURLTypeAndData(lnurl: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null>;

    /**
     * Returns satoshi value of BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    getLightningInvoiceValue(lnpr: string): BN;
}

export class Swapper<T extends MultiChain> extends EventEmitter implements SwapperBtcUtils {

    protected readonly logger = getLogger(this.constructor.name+": ");

    protected readonly swapStateListener: (swap: ISwap) => void;

    readonly chains: MultiChainData<T>;

    readonly prices: ISwapPrice<T>;
    readonly intermediaryDiscovery: IntermediaryDiscovery;
    readonly options: SwapperOptions;

    readonly mempoolApi: MempoolApi;
    readonly bitcoinRpc: MempoolBitcoinRpc;
    readonly bitcoinNetwork: Network;
    readonly tokens: {
        [chainId: string]: {
            [tokenAddress: string]: SCToken
        }
    };

    constructor(
        bitcoinRpc: MempoolBitcoinRpc,
        chainsData: CtorMultiChainData<T>,
        pricing: ISwapPrice<T>,
        tokens: WrapperCtorTokens<T>,
        options?: SwapperOptions
    ) {
        super();
        const storagePrefix = options?.storagePrefix || "";

        options.bitcoinNetwork = options.bitcoinNetwork==null ? BitcoinNetwork.TESTNET : options.bitcoinNetwork;

        this.bitcoinNetwork = options.bitcoinNetwork===BitcoinNetwork.MAINNET ? networks.bitcoin :
            options.bitcoinNetwork===BitcoinNetwork.REGTEST ? networks.regtest :
                options.bitcoinNetwork===BitcoinNetwork.TESTNET ? networks.testnet : null;

        this.prices = pricing;
        this.bitcoinRpc = bitcoinRpc;
        this.mempoolApi = bitcoinRpc.api;

        this.tokens = {};
        for(let tokenData of tokens) {
            for(let chainId in tokenData.chains) {
                const chainData = tokenData.chains[chainId];
                this.tokens[chainId] ??= {};
                this.tokens[chainId][chainData.address] = {
                    chain: "SC",
                    chainId,
                    ticker: tokenData.ticker,
                    name: tokenData.name,
                    decimals: chainData.decimals,
                    address: chainData.address
                }
            }
        }

        this.swapStateListener = (swap: ISwap) => {
            this.emit("swapState", swap);
        };

        this.chains = objectMap<CtorMultiChainData<T>, MultiChainData<T>>(chainsData, <InputKey extends keyof CtorMultiChainData<T>>(chainData: CtorMultiChainData<T>[InputKey], key: string) => {
            const {swapContract, chainEvents, btcRelay, defaultTrustedIntermediaryUrl} = chainData;
            const synchronizer = new MempoolBtcRelaySynchronizer(btcRelay, bitcoinRpc);

            const _storagePrefix = storagePrefix+key+"-";

            const tobtcln = new ToBTCLNWrapper<T[InputKey]>(
                key,
                chainData.storage?.toBtcLn || new IndexedDBStorageManager(_storagePrefix + "Swaps-ToBTCLN"),
                swapContract,
                chainEvents,
                pricing,
                tokens,
                chainData.swapDataConstructor,
                {
                    getRequestTimeout: options.getRequestTimeout,
                    postRequestTimeout: options.postRequestTimeout,
                }
            );
            const tobtc = new ToBTCWrapper<T[InputKey]>(
                key,
                chainData.storage?.toBtc || new IndexedDBStorageManager(_storagePrefix + "Swaps-ToBTC"),
                swapContract,
                chainEvents,
                pricing,
                tokens,
                chainData.swapDataConstructor,
                this.bitcoinRpc,
                {
                    getRequestTimeout: options.getRequestTimeout,
                    postRequestTimeout: options.postRequestTimeout,
                    bitcoinNetwork: this.bitcoinNetwork
                }
            );
            const frombtcln = new FromBTCLNWrapper<T[InputKey]>(
                key,
                chainData.storage?.fromBtcLn || new IndexedDBStorageManager(_storagePrefix + "Swaps-FromBTCLN"),
                swapContract,
                chainEvents,
                pricing,
                tokens,
                chainData.swapDataConstructor,
                bitcoinRpc,
                {
                    getRequestTimeout: options.getRequestTimeout,
                    postRequestTimeout: options.postRequestTimeout
                }
            );
            const frombtc = new FromBTCWrapper<T[InputKey]>(
                key,
                chainData.storage?.fromBtc || new IndexedDBStorageManager(_storagePrefix + "Swaps-FromBTC"),
                swapContract,
                chainEvents,
                pricing,
                tokens,
                chainData.swapDataConstructor,
                btcRelay,
                synchronizer,
                this.bitcoinRpc,
                {
                    getRequestTimeout: options.getRequestTimeout,
                    postRequestTimeout: options.postRequestTimeout,
                    bitcoinNetwork: this.bitcoinNetwork
                }
            );
            const lnforgas = new LnForGasWrapper<T[InputKey]>(
                key,
                chainData.storage?.lnForGas || new LocalStorageManager<LnForGasSwap<T[InputKey]>>(_storagePrefix + "LnForGas"),
                swapContract,
                chainEvents,
                pricing,
                tokens,
                chainData.swapDataConstructor,
                {
                    getRequestTimeout: options.getRequestTimeout,
                    postRequestTimeout: options.postRequestTimeout
                }
            );

            tobtcln.events.on("swapState", this.swapStateListener);
            tobtc.events.on("swapState", this.swapStateListener);
            frombtcln.events.on("swapState", this.swapStateListener);
            frombtc.events.on("swapState", this.swapStateListener);
            lnforgas.events.on("swapState", this.swapStateListener);

            return {
                chainEvents,
                swapContract,
                btcRelay,
                synchronizer,

                tobtcln,
                tobtc,
                frombtcln,
                frombtc,
                lnforgas,
                defaultTrustedIntermediaryUrl
            }
        });

        const contracts = objectMap(chainsData, (data) => data.swapContract);
        if(options.intermediaryUrl!=null) {
            this.intermediaryDiscovery = new IntermediaryDiscovery(contracts, options.registryUrl, Array.isArray(options.intermediaryUrl) ? options.intermediaryUrl : [options.intermediaryUrl], options.getRequestTimeout);
        } else {
            this.intermediaryDiscovery = new IntermediaryDiscovery(contracts, options.registryUrl, null, options.getRequestTimeout);
        }

        this.intermediaryDiscovery.on("removed", (intermediaries: Intermediary[]) => {
            this.emit("lpsRemoved", intermediaries);
        });

        this.intermediaryDiscovery.on("added", (intermediaries: Intermediary[]) => {
            this.emit("lpsAdded", intermediaries);
        });

        this.options = options;
    }

    /**
     * Returns true if string is a valid BOLT11 bitcoin lightning invoice
     *
     * @param lnpr
     */
    private isLightningInvoice(lnpr: string): boolean {
        try {
            bolt11Decode(lnpr);
            return true;
        } catch (e) {}
        return false;
    }

    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param addr
     */
    isValidBitcoinAddress(addr: string): boolean {
        try {
            address.toOutputScript(addr, this.bitcoinNetwork);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Returns true if string is a valid BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    isValidLightningInvoice(lnpr: string): boolean {
        try {
            const parsed = bolt11Decode(lnpr);
            if(parsed.millisatoshis!=null) return true;
        } catch (e) {}
        return false;
    }

    /**
     * Returns true if string is a valid LNURL (no checking on type is performed)
     *
     * @param lnurl
     */
    isValidLNURL(lnurl: string): boolean {
        return LNURL.isLNURL(lnurl);
    }

    /**
     * Returns type and data about an LNURL
     *
     * @param lnurl
     * @param shouldRetry
     */
    getLNURLTypeAndData(lnurl: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null> {
        return LNURL.getLNURLType(lnurl, shouldRetry);
    }

    /**
     * Returns satoshi value of BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    getLightningInvoiceValue(lnpr: string): BN {
        const parsed = bolt11Decode(lnpr);
        if(parsed.millisatoshis!=null) return new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
        return null;
    }

    getSwapBounds<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string): SwapBounds;
    getSwapBounds(): MultichainSwapBounds;

    /**
     * Returns swap bounds (minimums & maximums) for different swap types & tokens
     */
    getSwapBounds<ChainIdentifier extends ChainIds<T>>(chainIdentifier?: ChainIdentifier | string): SwapBounds | MultichainSwapBounds {
        if(this.intermediaryDiscovery!=null) {
            if(chainIdentifier==null) {
                return this.intermediaryDiscovery.getMultichainSwapBounds();
            } else {
                return this.intermediaryDiscovery.getSwapBounds(chainIdentifier);
            }
        }
        return null;
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param chainIdentifier
     * @param type      Type of the swap
     * @param token     Token of the swap
     */
    getMaximum<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string, type: SwapType, token: string): BN {
        if(this.intermediaryDiscovery!=null) {
            const max = this.intermediaryDiscovery.getSwapMaximum(chainIdentifier, type, token);
            if(max!=null) return new BN(max);
        }
        return new BN(0);
    }

    /**
     * Returns minimum possible swap amount
     *
     * @param chainIdentifier
     * @param type      Type of swap
     * @param token     Token of the swap
     */
    getMinimum<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string, type: SwapType, token: string): BN {
        if(this.intermediaryDiscovery!=null) {
            const min = this.intermediaryDiscovery.getSwapMinimum(chainIdentifier, type, token);
            if(min!=null) return new BN(min);
        }
        return new BN(0);
    }

    /**
     * Initializes the swap storage and loads existing swaps, needs to be called before any other action
     */
    async init() {
        this.logger.info("init(): Intializing swapper: ", this);

        for(let chainIdentifier in this.chains) {
            const {
                swapContract,
                chainEvents,
                tobtcln,
                tobtc,
                frombtcln,
                frombtc,
                lnforgas
            } = this.chains[chainIdentifier];
            await swapContract.start();
            this.logger.info("init(): Intialized swap contract: "+chainIdentifier);

            await chainEvents.init();
            this.logger.info("init(): Intialized events: "+chainIdentifier);

            this.logger.info("init(): Initializing To BTCLN: "+chainIdentifier);
            await tobtcln.init();
            this.logger.info("init(): Initializing To BTC: "+chainIdentifier);
            await tobtc.init();
            this.logger.info("init(): Initializing From BTCLN: "+chainIdentifier);
            await frombtcln.init();
            this.logger.info("init(): Initializing From BTC: "+chainIdentifier);
            await frombtc.init();

            this.logger.info("init(): Initializing To LN for gas: "+chainIdentifier);
            await lnforgas.init();
        }

        this.logger.info("init(): Initializing intermediary discovery");
        await this.intermediaryDiscovery.init();
    }

    /**
     * Stops listening for onchain events and closes this Swapper instance
     */
    async stop() {
        for(let chainIdentifier in this.chains) {
            const {
                tobtcln,
                tobtc,
                frombtcln,
                frombtc,
                lnforgas
            } = this.chains[chainIdentifier];
            tobtcln.events.off("swapState", this.swapStateListener);
            tobtc.events.off("swapState", this.swapStateListener);
            frombtcln.events.off("swapState", this.swapStateListener);
            frombtc.events.off("swapState", this.swapStateListener);
            lnforgas.events.off("swapState", this.swapStateListener);
            await tobtcln.stop();
            await tobtc.stop();
            await frombtcln.stop();
            await frombtc.stop();
            await lnforgas.stop();
        }
    }

    /**
     * Returns a set of supported tokens by all the intermediaries offering a specific swap service
     *
     * @param swapType Swap service type to check supported tokens for
     */
    getSupportedTokens(swapType: SwapType): SCToken[] {
        const tokens: SCToken[] = [];
        this.intermediaryDiscovery.intermediaries.forEach(lp => {
            if(lp.services[swapType]==null) return;
            if(lp.services[swapType].chainTokens==null) return;
            for(let chainId in lp.services[swapType].chainTokens) {
                for(let tokenAddress of lp.services[swapType].chainTokens[chainId]) {
                    const token = this.tokens?.[chainId]?.[tokenAddress];
                    if(token!=null) tokens.push(token);
                }
            }
        });
        return tokens;
    }

    /**
     * Returns the set of supported token addresses by all the intermediaries we know of offering a specific swapType service
     *
     * @param chainIdentifier
     * @param swapType Specific swap type for which to obtain supported tokens
     */
    getSupportedTokenAddresses<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string, swapType: SwapType): Set<string> {
        const set = new Set<string>();
        this.intermediaryDiscovery.intermediaries.forEach(lp => {
            if(lp.services[swapType]==null) return;
            if(lp.services[swapType].chainTokens==null || lp.services[swapType].chainTokens[chainIdentifier]==null) return;
            lp.services[swapType].chainTokens[chainIdentifier].forEach(token => set.add(token));
        });
        return set;
    }

    /**
     * Creates swap & handles intermediary, quote selection
     *
     * @param chainIdentifier
     * @param create Callback to create the
     * @param amountData Amount data as passed to the function
     * @param swapType Swap type of the execution
     * @param maxWaitTimeMS Maximum waiting time after the first intermediary returns the quote
     * @private
     * @throws {Error} when no intermediary was found
     * @throws {Error} if the chain with the provided identifier cannot be found
     */
    private async createSwap<ChainIdentifier extends ChainIds<T>, S extends ISwap<T[ChainIdentifier]>>(
        chainIdentifier: ChainIdentifier,
        create: (candidates: Intermediary[], abortSignal: AbortSignal, chain: ChainSpecificData<T[ChainIdentifier]>) => Promise<{
            quote: Promise<S>,
            intermediary: Intermediary
        }[]>,
        amountData: AmountData,
        swapType: SwapType,
        maxWaitTimeMS: number = 2000
    ): Promise<S> {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        let candidates: Intermediary[];

        const inBtc: boolean = swapType===SwapType.TO_BTCLN || swapType===SwapType.TO_BTC ? !amountData.exactIn : amountData.exactIn;

        if(!inBtc) {
            //Get candidates not based on the amount
            candidates = this.intermediaryDiscovery.getSwapCandidates(chainIdentifier, swapType, amountData.token);
        } else {
            candidates = this.intermediaryDiscovery.getSwapCandidates(chainIdentifier, swapType, amountData.token, amountData.amount);
        }

        if(candidates.length===0)  {
            this.logger.warn("createSwap(): No valid intermediary found, reloading intermediary database...");
            await this.intermediaryDiscovery.reloadIntermediaries();

            if(!inBtc) {
                //Get candidates not based on the amount
                candidates = this.intermediaryDiscovery.getSwapCandidates(chainIdentifier, swapType, amountData.token);
            } else {
                candidates = this.intermediaryDiscovery.getSwapCandidates(chainIdentifier, swapType, amountData.token, amountData.amount);
            }

            if(candidates.length===0) throw new Error("No intermediary found!");
        }


        const abortController = new AbortController();
        this.logger.debug("createSwap() Swap candidates: ", candidates.map(lp => lp.url).join());
        const quotePromises: {quote: Promise<S>, intermediary: Intermediary}[] = await create(candidates, abortController.signal, this.chains[chainIdentifier]);

        const quotes = await new Promise<{
            quote: S,
            intermediary: Intermediary
        }[]>((resolve, reject) => {
            let min: BN;
            let max: BN;
            let error: Error;
            let numResolved = 0;
            let quotes: {
                quote: S,
                intermediary: Intermediary
            }[] = [];
            let timeout: NodeJS.Timeout;

            quotePromises.forEach(data => {
                data.quote.then(quote => {
                    if(numResolved===0) {
                        timeout = setTimeout(() => {
                            abortController.abort(new Error("Timed out waiting for quote!"));
                            resolve(quotes);
                        }, maxWaitTimeMS);
                    }
                    numResolved++;
                    quotes.push({
                        quote,
                        intermediary: data.intermediary
                    });
                    if(numResolved===quotePromises.length) {
                        clearTimeout(timeout);
                        resolve(quotes);
                        return;
                    }
                }).catch(e => {
                    numResolved++;
                    if(e instanceof IntermediaryError) {
                        //Blacklist that node
                        this.intermediaryDiscovery.removeIntermediary(data.intermediary);
                    }
                    if(e instanceof OutOfBoundsError) {
                        if(min==null || max==null) {
                            min = e.min;
                            max = e.max;
                        } else {
                            min = BN.min(min, e.min);
                            max = BN.max(max, e.max);
                        }
                    }
                    this.logger.error("createSwap(): Intermediary "+data.intermediary.url+" error: ", e);
                    error = e;

                    if(numResolved===quotePromises.length) {
                        if(timeout!=null) clearTimeout(timeout);
                        if(quotes.length>0) {
                            resolve(quotes);
                            return;
                        }
                        if(min!=null && max!=null) {
                            reject(new OutOfBoundsError("Out of bounds", 400, min, max));
                            return;
                        }
                        reject(error);
                    }
                });
            });
        });

        //TODO: Intermediary's reputation is not taken into account!
        quotes.sort((a, b) => {
            if(amountData.exactIn) {
                //Compare outputs
                return b.quote.getOutput().rawAmount.cmp(a.quote.getOutput().rawAmount);
            } else {
                //Compare inputs
                return a.quote.getInput().rawAmount.cmp(b.quote.getInput().rawAmount);
            }
        });

        this.logger.debug("createSwap(): Sorted quotes, best price to worst: ", quotes)

        return quotes[0].quote;
    }

    /**
     * Creates To BTC swap
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress          Token address to pay with
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in satoshis (bitcoin's smallest denomination)
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     * @param exactIn               Whether to use exact in instead of exact out
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    createToBTCSwap<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        address: string,
        amount: BN,
        confirmationTarget?: number,
        confirmations?: number,
        exactIn?: boolean,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<ToBTCSwap<T[ChainIdentifier]>> {
        if(confirmationTarget==null) confirmationTarget = 3;
        if(confirmations==null) confirmations = 2;
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn
        };
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal, chain) => Promise.resolve(chain.tobtc.create(
                signer,
                address,
                amountData,
                candidates,
                {
                    confirmationTarget,
                    confirmations
                },
                additionalParams,
                abortSignal
            )),
            amountData,
            SwapType.TO_BTC
        );
    }

    /**
     * Creates To BTCLN swap
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress          Token address to pay with
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     * @param maxRoutingBaseFee     Maximum routing fee to use - base fee (higher routing fee means higher probability of payment success)
     * @param maxRoutingPPM         Maximum routing fee to use - proportional fee in PPM (higher routing fee means higher probability of payment success)
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async createToBTCLNSwap<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        paymentRequest: string,
        expirySeconds?: number,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<ToBTCLNSwap<T[ChainIdentifier]>> {
        const parsedPR = bolt11Decode(paymentRequest);
        const amountData = {
            amount: new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000)),
            token: tokenAddress,
            exactIn: false
        };
        expirySeconds ??= 4*24*3600;
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal: AbortSignal, chain) => Promise.resolve(chain.tobtcln.create(
                signer,
                paymentRequest,
                amountData,
                candidates,
                {
                    expirySeconds,
                    maxRoutingPPM,
                    maxRoutingBaseFee
                },
                additionalParams,
                abortSignal
            )),
            amountData,
            SwapType.TO_BTCLN
        );
    }

    /**
     * Creates To BTCLN swap via LNURL-pay
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress          Token address to pay with
     * @param lnurlPay              LNURL-pay link to use for the payment
     * @param amount                Amount to be paid in sats
     * @param comment               Optional comment for the payment
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     * @param maxRoutingBaseFee     Maximum routing fee to use - base fee (higher routing fee means higher probability of payment success)
     * @param maxRoutingPPM         Maximum routing fee to use - proportional fee in PPM (higher routing fee means higher probability of payment success)
     * @param exactIn               Whether to do an exact in swap instead of exact out
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async createToBTCLNSwapViaLNURL<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        lnurlPay: string | LNURLPay,
        amount: BN,
        comment: string,
        expirySeconds?: number,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        exactIn?: boolean,
        additionalParams: Record<string, any>  = this.options.defaultAdditionalParameters
    ): Promise<ToBTCLNSwap<T[ChainIdentifier]>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn
        };
        expirySeconds ??= 4*24*3600;
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal: AbortSignal, chain) => chain.tobtcln.createViaLNURL(
                signer,
                typeof(lnurlPay)==="string" ? lnurlPay : lnurlPay.params,
                amountData,
                candidates,
                {
                    expirySeconds,
                    comment,
                    maxRoutingBaseFee,
                    maxRoutingPPM
                },
                additionalParams,
                abortSignal
            ),
            amountData,
            SwapType.TO_BTCLN
        );
    }

    /**
     * Creates From BTC swap
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress          Token address to receive
     * @param amount                Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut              Whether to use a exact out instead of exact in
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCSwap<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        amount: BN,
        exactOut?: boolean,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCSwap<T[ChainIdentifier]>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: !exactOut
        };
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal: AbortSignal, chain) => Promise.resolve(chain.frombtc.create(
                signer,
                amountData,
                candidates,
                null,
                additionalParams,
                abortSignal
            )),
            amountData,
            SwapType.FROM_BTC
        );
    }

    /**
     * Creates From BTCLN swap
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress      Token address to receive
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut          Whether to use exact out instead of exact in
     * @param descriptionHash   Description hash for ln invoice
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCLNSwap<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        amount: BN,
        exactOut?: boolean,
        descriptionHash?: Buffer,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCLNSwap<T[ChainIdentifier]>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: !exactOut
        };
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal: AbortSignal, chain) => Promise.resolve(chain.frombtcln.create(
                signer,
                amountData,
                candidates,
                {
                    descriptionHash
                },
                additionalParams,
                abortSignal
            )),
            amountData,
            SwapType.FROM_BTCLN
        );
    }

    /**
     * Creates From BTCLN swap, withdrawing from LNURL-withdraw
     *
     * @param chainIdentifier
     * @param signer
     * @param tokenAddress      Token address to receive
     * @param lnurl             LNURL-withdraw to pull the funds from
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut          Whether to use exact out instead of exact in
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCLNSwapViaLNURL<ChainIdentifier extends ChainIds<T>>(
        chainIdentifier: ChainIdentifier | string,
        signer: string,
        tokenAddress: string,
        lnurl: string | LNURLWithdraw,
        amount: BN,
        exactOut?: boolean,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCLNSwap<T[ChainIdentifier]>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: !exactOut
        };
        return this.createSwap(
            chainIdentifier as ChainIdentifier,
            (candidates: Intermediary[], abortSignal: AbortSignal, chain) => chain.frombtcln.createViaLNURL(
                signer,
                typeof(lnurl)==="string" ? lnurl : lnurl.params,
                amountData,
                candidates,
                additionalParams,
                abortSignal
            ),
            amountData,
            SwapType.FROM_BTCLN
        );
    }

    create<C extends ChainIds<T>>(signer: string, srcToken: BtcToken<true>, dstToken: SCToken<C>, amount: BN, exactIn: boolean, lnurlWithdraw?: string | LNURLWithdraw): Promise<FromBTCLNSwap<T[C]>>;
    create<C extends ChainIds<T>>(signer: string, srcToken: BtcToken<false>, dstToken: SCToken<C>, amount: BN, exactIn: boolean): Promise<FromBTCSwap<T[C]>>;
    create<C extends ChainIds<T>>(signer: string, srcToken: SCToken<C>, dstToken: BtcToken<false>, amount: BN, exactIn: boolean, address: string): Promise<ToBTCSwap<T[C]>>;
    create<C extends ChainIds<T>>(signer: string, srcToken: SCToken<C>, dstToken: BtcToken<true>, amount: BN, exactIn: boolean, lnurlPay: string | LNURLPay): Promise<ToBTCLNSwap<T[C]>>;
    create<C extends ChainIds<T>>(signer: string, srcToken: SCToken<C>, dstToken: BtcToken<true>, amount: BN, exactIn: false, lightningInvoice: string): Promise<ToBTCLNSwap<T[C]>>;
    create<C extends ChainIds<T>>(signer: string, srcToken: Token<C>, dstToken: Token<C>, amount: BN, exactIn: boolean, addressLnurlLightningInvoice?: string | LNURLWithdraw | LNURLPay): Promise<ISwap<T[C]>>;
    /**
     * Creates a swap from srcToken to dstToken, of a specific token amount, either specifying input amount (exactIn=true)
     *  or output amount (exactIn=false), NOTE: For regular -> BTC-LN (lightning) swaps the passed amount is ignored and
     *  invoice's pre-set amount is used instead.
     *
     * @param signer
     * @param srcToken Source token of the swap, user pays this token
     * @param dstToken Destination token of the swap, user receives this token
     * @param amount Amount of the swap
     * @param exactIn Whether the amount specified is an input amount (exactIn=true) or an output amount (exactIn=false)
     * @param addressLnurlLightningInvoice Bitcoin on-chain address, lightning invoice, LNURL-pay to pay or
     *  LNURL-withdrawal to withdraw money from
     */
    create<C extends ChainIds<T>>(signer: string, srcToken: Token<C>, dstToken: Token<C>, amount: BN, exactIn: boolean, addressLnurlLightningInvoice?: string | LNURLWithdraw | LNURLPay): Promise<ISwap<T[C]>> {
        if(srcToken.chain==="BTC") {
            if(dstToken.chain==="SC") {
                if(srcToken.lightning) {
                    if(addressLnurlLightningInvoice!=null) {
                        if(typeof(addressLnurlLightningInvoice)!=="string" && !isLNURLWithdraw(addressLnurlLightningInvoice)) throw new Error("LNURL must be a string or LNURLWithdraw object!");
                        return this.createFromBTCLNSwapViaLNURL(dstToken.chainId, signer, dstToken.address, addressLnurlLightningInvoice, amount, !exactIn);
                    } else {
                        return this.createFromBTCLNSwap(dstToken.chainId, signer, dstToken.address, amount, !exactIn);
                    }
                } else {
                    return this.createFromBTCSwap(dstToken.chainId, signer, dstToken.address, amount, !exactIn);
                }
            }
        } else {
            if(dstToken.chain==="BTC") {
                if(dstToken.lightning) {
                    if(typeof(addressLnurlLightningInvoice)!=="string" && !isLNURLPay(addressLnurlLightningInvoice)) throw new Error("Destination LNURL link/lightning invoice must be a string or LNURLPay object!");
                    if(isLNURLPay(addressLnurlLightningInvoice) || this.isValidLNURL(addressLnurlLightningInvoice)) {
                        return this.createToBTCLNSwapViaLNURL(srcToken.chainId, signer, srcToken.address, addressLnurlLightningInvoice, amount, null, null, null, null, exactIn);
                    } else if(this.isLightningInvoice(addressLnurlLightningInvoice)) {
                        if(!this.isValidLightningInvoice(addressLnurlLightningInvoice))
                            throw new Error("Invalid lightning invoice specified, lightning invoice MUST contain pre-set amount!");
                        if(exactIn)
                            throw new Error("Only exact out swaps are possible with lightning invoices, use LNURL links for exact in lightning swaps!");
                        return this.createToBTCLNSwap(srcToken.chainId, signer, srcToken.address, addressLnurlLightningInvoice);
                    } else {
                        throw new Error("Supplied parameter is not LNURL link nor lightning invoice (bolt11)!");
                    }
                } else {
                    if(typeof(addressLnurlLightningInvoice)!=="string") throw new Error("Destination bitcoin address must be a string!");
                    return this.createToBTCSwap(srcToken.chainId, signer, srcToken.address, addressLnurlLightningInvoice, amount, null, null, exactIn);
                }
            }
        }
        throw new Error("Unsupported swap type");
    }

    /**
     * Creates trusted LN for Gas swap
     *
     * @param chainId
     * @param signer
     * @param amount                    Amount of native token to receive, in base units
     * @param trustedIntermediaryUrl    URL of the trusted intermediary to use, otherwise uses default
     * @throws {Error} If no trusted intermediary specified
     */
    createTrustedLNForGasSwap<C extends ChainIds<T>>(chainId: C | string, signer: string, amount: BN, trustedIntermediaryUrl?: string): Promise<LnForGasSwap<T[C]>> {
        if(this.chains[chainId]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainId);
        const useUrl = trustedIntermediaryUrl || this.chains[chainId].defaultTrustedIntermediaryUrl;
        if(useUrl==null) throw new Error("No trusted intermediary URL specified!");
        return this.chains[chainId as C].lnforgas.create(signer, amount, useUrl);
    }

    /**
     * Returns all swaps
     */
    getAllSwaps(): Promise<ISwap[]>;

    /**
     * Returns all swaps for the specific chain, and optionally also for a specific signer's address
     */
    getAllSwaps<C extends ChainIds<T>>(chainId: C | string, signer?: string): Promise<ISwap<T[C]>[]>;

    async getAllSwaps<C extends ChainIds<T>>(chainId?: C | string, signer?: string): Promise<ISwap[]> {
        if(chainId==null) {
            const res: ISwap[] = [];
            for(let chainId in this.chains) {
                const chainData = this.chains[chainId];
                [].concat(
                    await chainData.tobtcln.getAllSwaps(),
                    await chainData.tobtc.getAllSwaps(),
                    await chainData.frombtcln.getAllSwaps(),
                    await chainData.frombtc.getAllSwaps(),
                ).forEach(val => res.push(val));
            }
            return res;
        } else {
            const chainData = this.chains[chainId];
            return [].concat(
                await chainData.tobtcln.getAllSwaps(signer),
                await chainData.tobtc.getAllSwaps(signer),
                await chainData.frombtcln.getAllSwaps(signer),
                await chainData.frombtc.getAllSwaps(signer),
            );
        }
    }

    /**
     * Returns all swaps where an action is required (either claim or refund)
     */
    getActionableSwaps(): Promise<ISwap[]>;

    /**
     * Returns swaps where an action is required (either claim or refund) for the specific chain, and optionally also for a specific signer's address
     */
    getActionableSwaps<C extends ChainIds<T>>(chainId: C | string, signer?: string): Promise<ISwap<T[C]>[]>;

    async getActionableSwaps<C extends ChainIds<T>>(chainId?: C | string, signer?: string): Promise<ISwap[]> {
        if(chainId==null) {
            const res: ISwap[] = [];
            for(let chainId in this.chains) {
                const chainData = this.chains[chainId];
                [].concat(
                    await chainData.tobtcln.getRefundableSwaps(),
                    await chainData.tobtc.getRefundableSwaps(),
                    await chainData.frombtcln.getClaimableSwaps(),
                    await chainData.frombtc.getClaimableSwaps(),
                ).forEach(val => res.push(val));
            }
            return res;
        } else {
            const chainData = this.chains[chainId];
            return [].concat(
                await chainData.tobtcln.getRefundableSwaps(signer),
                await chainData.tobtc.getRefundableSwaps(signer),
                await chainData.frombtcln.getClaimableSwaps(signer),
                await chainData.frombtc.getClaimableSwaps(signer),
            );
        }
    }

    /**
     * Returns all swaps that are refundable
     */
    getRefundableSwaps(): Promise<IToBTCSwap[]>;

    /**
     * Returns swaps that are refundable for the specific chain, and optionally also for a specific signer's address
     */
    getRefundableSwaps<C extends ChainIds<T>>(chainId: C | string, signer?: string): Promise<IToBTCSwap<T[C]>[]>;

    async getRefundableSwaps<C extends ChainIds<T>>(chainId?: C | string, signer?: string): Promise<IToBTCSwap[]> {
        if(chainId==null) {
            const res: IToBTCSwap[] = [];
            for(let chainId in this.chains) {
                const chainData = this.chains[chainId];
                [].concat(
                    await chainData.tobtcln.getRefundableSwaps(),
                    await chainData.tobtc.getRefundableSwaps()
                ).forEach(val => res.push(val));
            }
            return res;
        } else {
            const chainData = this.chains[chainId];
            return [].concat(
                await chainData.tobtcln.getRefundableSwaps(signer),
                await chainData.tobtc.getRefundableSwaps(signer)
            );
        }
    }

    /**
     * Returns all swaps that are in-progress and are claimable
     */
    getClaimableSwaps(): Promise<IFromBTCSwap[]>;

    /**
     * Returns swaps that are in-progress and are claimable for the specific chain, optionally also for a specific signer's address
     */
    getClaimableSwaps<C extends ChainIds<T>>(chainId: C | string, signer?: string): Promise<IFromBTCSwap<T[C]>[]>;

    async getClaimableSwaps<C extends ChainIds<T>>(chainId?: C | string, signer?: string): Promise<IFromBTCSwap[]> {
        if(chainId==null) {
            const res: IFromBTCSwap[] = [];
            for(let chainId in this.chains) {
                const chainData = this.chains[chainId];
                [].concat(
                    await chainData.frombtcln.getClaimableSwaps(),
                    await chainData.frombtc.getClaimableSwaps()
                ).forEach(val => res.push(val));
            }
            return res;
        } else {
            const chainData = this.chains[chainId];
            return [].concat(
                await chainData.frombtcln.getClaimableSwaps(signer),
                await chainData.frombtc.getClaimableSwaps(signer)
            );
        }
    }

    getBalance<ChainIdentifier extends ChainIds<T>>(signer: string, token: SCToken<ChainIdentifier | string>): Promise<BN>;
    getBalance<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string, signer: string, token: string): Promise<BN>;

    /**
     * Returns the token balance of the wallet
     */
    getBalance<ChainIdentifier extends ChainIds<T>>(chainIdentifierOrSigner: ChainIdentifier | string, signerOrToken: string | SCToken<ChainIdentifier | string>, token?: string): Promise<BN> {
        let chainIdentifier: ChainIdentifier | string;
        let signer: string;
        if(typeof(signerOrToken)==="string") {
            chainIdentifier = chainIdentifierOrSigner;
            signer = signerOrToken;
        } else {
            chainIdentifier = signerOrToken.chainId;
            token = signerOrToken.address;
            signer = chainIdentifierOrSigner;
        }
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return this.chains[chainIdentifier].swapContract.getBalance(signer, token, false);
    }

    /**
     * Returns the native token balance of the wallet
     */
    getNativeBalance<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string, signer: string): Promise<BN> {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return this.chains[chainIdentifier].swapContract.getBalance(signer, this.getNativeTokenAddress(chainIdentifier), false);
    }

    /**
     * Returns the address of the native token's address of the chain
     */
    getNativeTokenAddress<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string): string {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return this.chains[chainIdentifier].swapContract.getNativeCurrencyAddress();
    }

    /**
     * Returns the address of the native currency of the chain
     */
    getNativeToken<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string): SCToken<ChainIdentifier> {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return this.tokens[chainIdentifier][this.chains[chainIdentifier].swapContract.getNativeCurrencyAddress()] as SCToken<ChainIdentifier>;
    }

    withChain<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string): SwapperWithChain<T, ChainIdentifier> {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return new SwapperWithChain<T, ChainIdentifier>(this, chainIdentifier as ChainIdentifier);
    }

    randomSigner<ChainIdentifier extends ChainIds<T>>(chainIdentifier: ChainIdentifier | string): T[ChainIdentifier]["Signer"] {
        if(this.chains[chainIdentifier]==null) throw new Error("Invalid chain identifier! Unknown chain: "+chainIdentifier);
        return this.chains[chainIdentifier].swapContract.randomSigner();
    }

    getChains(): ChainIds<T>[] {
        return Object.keys(this.chains);
    }

}
