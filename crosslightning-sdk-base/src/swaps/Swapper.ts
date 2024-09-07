import {BitcoinNetwork} from "../btc/BitcoinNetwork";
import {ISwapPrice} from "../prices/abstract/ISwapPrice";
import {ChainEvents, IStorageManager, SwapContract, SwapData} from "crosslightning-base";
import {ToBTCLNWrapper} from "./tobtc/ln/ToBTCLNWrapper";
import {ToBTCWrapper} from "./tobtc/onchain/ToBTCWrapper";
import {FromBTCLNWrapper} from "./frombtc/ln/FromBTCLNWrapper";
import {FromBTCWrapper} from "./frombtc/onchain/FromBTCWrapper";
import {IntermediaryDiscovery, SwapBounds} from "../intermediaries/IntermediaryDiscovery";
import {networks, Network, address} from "bitcoinjs-lib";
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
import {LNURL, LNURLPay, LNURLWithdraw} from "../utils/LNURL";
import {AmountData} from "./ISwapWrapper";
import {getLogger} from "../utils/Utils";
import {OutOfBoundsError} from "../errors/RequestError";

export type SwapperOptions<T extends SwapData> = {
    intermediaryUrl?: string | string[],
    pricing?: ISwapPrice,
    registryUrl?: string,

    addresses?: {
        swapContract: string,
        btcRelayContract: string
    },
    bitcoinNetwork?: BitcoinNetwork,

    storage?: {
        toBtc?: IStorageManager<ToBTCSwap<T>>,
        fromBtc?: IStorageManager<FromBTCSwap<T>>,
        toBtcLn?: IStorageManager<ToBTCLNSwap<T>>,
        fromBtcLn?: IStorageManager<FromBTCLNSwap<T>>,
        lnForGas?: IStorageManager<LnForGasSwap<T>>
    },

    getRequestTimeout?: number,
    postRequestTimeout?: number,
    defaultTrustedIntermediaryUrl?: string,
    defaultAdditionalParameters?: {[key: string]: any}
};


export class Swapper<
    T extends SwapData = SwapData,
    E extends ChainEvents<T> = ChainEvents<T>,
    P extends SwapContract<T, TXType, any, any> = SwapContract<T, any, any, any>,
    TokenAddressType = any,
    TXType = any
> extends EventEmitter {

    protected readonly logger = getLogger(this.constructor.name+": ");

    readonly tobtcln: ToBTCLNWrapper<T>;
    readonly tobtc: ToBTCWrapper<T>;
    readonly frombtcln: FromBTCLNWrapper<T>;
    readonly frombtc: FromBTCWrapper<T>;

    readonly lnforgas: LnForGasWrapper<T>;

    readonly prices: ISwapPrice;
    readonly intermediaryDiscovery: IntermediaryDiscovery<T>;
    readonly chainEvents: E;
    readonly swapContract: P;
    readonly mempoolApi: MempoolApi;
    readonly options: SwapperOptions<T>;

    readonly bitcoinRpc: MempoolBitcoinRpc;
    readonly bitcoinNetwork: Network;
    readonly btcRelay: BtcRelay<any, TXType, MempoolBitcoinBlock>;
    readonly synchronizer: RelaySynchronizer<any, TXType, MempoolBitcoinBlock>

    constructor(
        btcRelay: BtcRelay<any, TXType, MempoolBitcoinBlock>,
        bitcoinRpc: MempoolBitcoinRpc,
        swapContract: P,
        chainEvents: E,
        swapDataConstructor: new (data: any) => T,
        options: SwapperOptions<T>,
        storagePrefix?: string
    ) {
        super();
        storagePrefix = storagePrefix || "";

        options.bitcoinNetwork = options.bitcoinNetwork==null ? BitcoinNetwork.TESTNET : options.bitcoinNetwork;

        switch (options.bitcoinNetwork) {
            case BitcoinNetwork.MAINNET:
                this.bitcoinNetwork = networks.bitcoin;
                this.mempoolApi = new MempoolApi("https://mempool.space/api/", options.getRequestTimeout);
                break;
            case BitcoinNetwork.TESTNET:
                this.bitcoinNetwork = networks.testnet;
                this.mempoolApi = new MempoolApi("https://mempool.space/testnet/api/", options.getRequestTimeout);
                break;
            default:
                throw new Error("Unsupported bitcoin network");
        }

        this.prices = options.pricing;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.bitcoinRpc = new MempoolBitcoinRpc(this.mempoolApi);
        this.btcRelay = btcRelay;
        this.synchronizer = new MempoolBtcRelaySynchronizer(btcRelay, bitcoinRpc);

        this.tobtcln = new ToBTCLNWrapper<T>(
            options.storage?.toBtcLn || new IndexedDBStorageManager(storagePrefix + "Swaps-ToBTCLN"),
            this.swapContract,
            this.chainEvents,
            options.pricing,
            swapDataConstructor,
            options
        );
        this.tobtc = new ToBTCWrapper<T>(
            options.storage?.toBtc || new IndexedDBStorageManager(storagePrefix + "Swaps-ToBTC"),
            this.swapContract,
            this.chainEvents,
            options.pricing,
            swapDataConstructor,
            this.bitcoinRpc,
            {
                getRequestTimeout: options.getRequestTimeout,
                postRequestTimeout: options.postRequestTimeout,
                bitcoinNetwork: this.bitcoinNetwork
            }
        );
        this.frombtcln = new FromBTCLNWrapper<T>(
            options.storage?.fromBtcLn || new IndexedDBStorageManager(storagePrefix + "Swaps-FromBTCLN"),
            this.swapContract,
            this.chainEvents,
            options.pricing,
            swapDataConstructor,
            this.bitcoinRpc,
            options
        );
        this.frombtc = new FromBTCWrapper<T>(
            options.storage?.fromBtc || new IndexedDBStorageManager(storagePrefix + "Swaps-FromBTC"),
            this.swapContract,
            this.chainEvents,
            options.pricing,
            swapDataConstructor,
            this.btcRelay,
            this.synchronizer,
            this.bitcoinRpc,
            {
                getRequestTimeout: options.getRequestTimeout,
                postRequestTimeout: options.postRequestTimeout,
                bitcoinNetwork: this.bitcoinNetwork
            }
        );
        this.lnforgas = new LnForGasWrapper<T>(
            options.storage?.lnForGas || new LocalStorageManager<LnForGasSwap<T>>(storagePrefix + "LnForGas"),
            this.swapContract,
            this.chainEvents,
            options.pricing,
            swapDataConstructor,
            {
                getRequestTimeout: options.getRequestTimeout,
                postRequestTimeout: options.postRequestTimeout
            }
        );

        if(options.intermediaryUrl!=null) {
            this.intermediaryDiscovery = new IntermediaryDiscovery<T>(swapContract, options.registryUrl, Array.isArray(options.intermediaryUrl) ? options.intermediaryUrl : [options.intermediaryUrl], options.getRequestTimeout);
        } else {
            this.intermediaryDiscovery = new IntermediaryDiscovery<T>(swapContract, options.registryUrl, null, options.getRequestTimeout);
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
     * @param lnpr
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

    /**
     * Returns swap bounds (minimums & maximums) for different swap types & tokens
     */
    getSwapBounds(): SwapBounds {
        if(this.intermediaryDiscovery!=null) {
            return this.intermediaryDiscovery.getSwapBounds();
        }
        return null;
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param type      Type of the swap
     * @param token     Token of the swap
     */
    getMaximum(type: SwapType, token: TokenAddressType): BN {
        if(this.intermediaryDiscovery!=null) {
            const max = this.intermediaryDiscovery.getSwapMaximum(type, token);
            if(max!=null) return new BN(max);
        }
        return new BN(0);
    }

    /**
     * Returns minimum possible swap amount
     *
     * @param type      Type of swap
     * @param token     Token of the swap
     */
    getMinimum(type: SwapType, token: TokenAddressType): BN {
        if(this.intermediaryDiscovery!=null) {
            const min = this.intermediaryDiscovery.getSwapMinimum(type, token);
            if(min!=null) return new BN(min);
        }
        return new BN(0);
    }

    /**
     * Initializes the swap storage and loads existing swaps, needs to be called before any other action
     */
    async init() {
        await this.swapContract.start();
        this.logger.info("init(): Intializing swapper: ", this);

        await this.chainEvents.init();

        this.logger.info("init(): Initializing To BTCLN");
        await this.tobtcln.init();
        this.logger.info("init(): Initializing To BTC");
        await this.tobtc.init();
        this.logger.info("init(): Initializing From BTCLN");
        await this.frombtcln.init();
        this.logger.info("init(): Initializing From BTC");
        await this.frombtc.init();

        this.logger.info("init(): Initializing To LN for gas");
        await this.lnforgas.init();

        this.logger.info("init(): Initializing intermediary discovery");
        await this.intermediaryDiscovery.init();
    }

    /**
     * Stops listening for onchain events and closes this Swapper instance
     */
    async stop() {
        await this.tobtcln.stop();
        await this.tobtc.stop();
        await this.frombtcln.stop();
        await this.frombtc.stop();
        await this.lnforgas.stop();
    }

    /**
     * Returns the set of supported tokens by all the intermediaries we know of offering a specific swapType service
     *
     * @param swapType Specific swap type for which to obtain supported tokens
     */
    getSupportedTokens(swapType: SwapType): Set<string> {
        const set = new Set<string>();
        this.intermediaryDiscovery.intermediaries.forEach(lp => {
            if(lp.services[swapType]==null) return;
            lp.services[swapType].tokens.forEach(token => set.add(token));
        });
        return set;
    }

    /**
     * Creates swap & handles intermediary, quote selection
     *
     * @param create Callback to create the
     * @param amountData Amount data as passed to the function
     * @param swapType Swap type of the execution
     * @param maxWaitTimeMS Maximum waiting time after the first intermediary returns the quote
     * @private
     * @throws {Error} when no intermediary was found
     */
    private async createSwap<S extends ISwap<T>>(
        create: (candidates: Intermediary[], abortSignal: AbortSignal) => Promise<{
            quote: Promise<S>,
            intermediary: Intermediary
        }[]>,
        amountData: AmountData,
        swapType: SwapType,
        maxWaitTimeMS: number = 2000
    ): Promise<S> {
        let candidates: Intermediary[];

        const inBtc: boolean = swapType===SwapType.TO_BTCLN || swapType===SwapType.TO_BTC ? !amountData.exactIn : amountData.exactIn;

        if(!inBtc) {
            //Get candidates not based on the amount
            candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token);
        } else {
            candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token, amountData.amount);
        }

        if(candidates.length===0)  {
            this.logger.warn("createSwap(): No valid intermediary found, reloading intermediary database...");
            await this.intermediaryDiscovery.reloadIntermediaries();

            if(!inBtc) {
                //Get candidates not based on the amount
                candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token);
            } else {
                candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token, amountData.amount);
            }

            if(candidates.length===0) throw new Error("No intermediary found!");
        }


        const abortController = new AbortController();
        this.logger.debug("createSwap() Swap candidates: ", candidates.map(lp => lp.url).join());
        const quotePromises: {quote: Promise<S>, intermediary: Intermediary}[] = await create(candidates, abortController.signal);

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
                return b.quote.getOutAmount().cmp(a.quote.getOutAmount());
            } else {
                //Compare inputs
                return a.quote.getInAmount().cmp(b.quote.getInAmount());
            }
        });

        this.logger.debug("createSwap(): Sorted quotes, best price to worst: ", quotes)

        return quotes[0].quote;
    }

    /**
     * Creates To BTC swap
     *
     * @param tokenAddress          Token address to pay with
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in satoshis (bitcoin's smallest denomination)
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     * @param exactIn               Whether to use exact in instead of exact out
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    createToBTCSwap(
        tokenAddress: TokenAddressType,
        address: string,
        amount: BN,
        confirmationTarget?: number,
        confirmations?: number,
        exactIn?: boolean,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<ToBTCSwap<T, TXType>> {
        if(confirmationTarget==null) confirmationTarget = 3;
        if(confirmations==null) confirmations = 2;
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn
        };
        return this.createSwap<ToBTCSwap<T>>(
            (candidates: Intermediary[], abortSignal) => Promise.resolve(this.tobtc.create(
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
     * @param tokenAddress          Token address to pay with
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     * @param maxRoutingBaseFee     Maximum routing fee to use - base fee (higher routing fee means higher probability of payment success)
     * @param maxRoutingPPM         Maximum routing fee to use - proportional fee in PPM (higher routing fee means higher probability of payment success)
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async createToBTCLNSwap(
        tokenAddress: TokenAddressType,
        paymentRequest: string,
        expirySeconds: number = 3*24*3600,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<ToBTCLNSwap<T, TXType>> {
        const parsedPR = bolt11Decode(paymentRequest);
        const amountData = {
            amount: new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000)),
            token: tokenAddress,
            exactIn: false
        };
        return this.createSwap<ToBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => Promise.resolve(this.tobtcln.create(
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
    async createToBTCLNSwapViaLNURL(
        tokenAddress: TokenAddressType,
        lnurlPay: string | LNURLPay,
        amount: BN,
        comment: string,
        expirySeconds: number = 3*24*3600,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        exactIn?: boolean,
        additionalParams: Record<string, any>  = this.options.defaultAdditionalParameters
    ): Promise<ToBTCLNSwap<T, TXType>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn
        };
        return this.createSwap<ToBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => this.tobtcln.createViaLNURL(
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
     * @param tokenAddress          Token address to receive
     * @param amount                Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut              Whether to use a exact out instead of exact in
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCSwap(
        tokenAddress: TokenAddressType,
        amount: BN,
        exactOut?: boolean,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCSwap<T, TXType>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: !exactOut
        };
        return this.createSwap<FromBTCSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => Promise.resolve(this.frombtc.create(
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
     * @param tokenAddress      Token address to receive
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut          Whether to use exact out instead of exact in
     * @param descriptionHash   Description hash for ln invoice
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCLNSwap(
        tokenAddress: TokenAddressType,
        amount: BN,
        exactOut?: boolean,
        descriptionHash?: Buffer,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCLNSwap<T, TXType>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: !exactOut
        };
        return this.createSwap<FromBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => Promise.resolve(this.frombtcln.create(
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
     * @param tokenAddress      Token address to receive
     * @param lnurl             LNURL-withdraw to pull the funds from
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async createFromBTCLNSwapViaLNURL(
        tokenAddress: TokenAddressType,
        lnurl: string | LNURLWithdraw,
        amount: BN,
        additionalParams: Record<string, any> = this.options.defaultAdditionalParameters
    ): Promise<FromBTCLNSwap<T, TXType>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: true
        };
        return this.createSwap<FromBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => this.frombtcln.createViaLNURL(
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

    /**
     * Creates trusted LN for Gas swap
     *
     * @param amount                    Amount of native token to receive, in base units
     * @param trustedIntermediaryUrl    URL of the trusted intermediary to use, otherwise uses default
     * @throws {Error} If no trusted intermediary specified
     */
    createTrustedLNForGasSwap(amount: BN, trustedIntermediaryUrl?: string): Promise<LnForGasSwap<T>> {
        const useUrl = trustedIntermediaryUrl || this.options.defaultTrustedIntermediaryUrl;
        if(useUrl==null) throw new Error("No trusted intermediary URL specified!");
        return this.lnforgas.create(amount, useUrl);
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<ISwap<T>[]> {
        return [].concat(
            await this.tobtcln.getAllSwaps(),
            await this.tobtc.getAllSwaps(),
            await this.frombtcln.getAllSwaps(),
            await this.frombtc.getAllSwaps(),
        );
    }

    /**
     * Returns swaps that were initiated with the current provider's public key, and there is an action required (either claim or refund)
     */
    async getActionableSwaps(): Promise<ISwap<T>[]> {
        return [].concat(
            await this.tobtcln.getRefundableSwaps(),
            await this.tobtc.getRefundableSwaps(),
            await this.frombtcln.getClaimableSwaps(),
            await this.frombtc.getClaimableSwaps(),
        );
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps(): Promise<IToBTCSwap<T, TXType>[]> {
        return [].concat(
            await this.tobtcln.getRefundableSwaps(),
            await this.tobtc.getRefundableSwaps()
        );
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<IFromBTCSwap<T>[]> {
        return [].concat(
            await this.frombtcln.getClaimableSwaps(),
            await this.frombtc.getClaimableSwaps()
        );
    }

    /**
     * Returns the token balance of the wallet
     */
    getBalance(token: TokenAddressType): Promise<BN> {
        return this.swapContract.getBalance(token, false);
    }

    /**
     * Returns the address of the native currency of the chain
     */
    getNativeCurrency(): TokenAddressType {
        return this.swapContract.getNativeCurrencyAddress();
    }

    /**
     * Returns the smart chain on-chain address of the underlying provider
     */
    getAddress(): string {
        return this.swapContract.getAddress();
    }

}