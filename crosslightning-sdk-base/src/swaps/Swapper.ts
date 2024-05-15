import {BitcoinNetwork} from "../btc/BitcoinNetwork";
import {ISwapPrice} from "./ISwapPrice";
import {IWrapperStorage} from "../storage/IWrapperStorage";
import {ChainEvents, IStorageManager, SwapContract, SwapData, TokenAddress} from "crosslightning-base";
import {ToBTCLNWrapper} from "./tobtc/ln/ToBTCLNWrapper";
import {ToBTCWrapper} from "./tobtc/onchain/ToBTCWrapper";
import {FromBTCLNWrapper} from "./frombtc/ln/FromBTCLNWrapper";
import {FromBTCWrapper} from "./frombtc/onchain/FromBTCWrapper";
import {AmountData, ClientSwapContract, LNURLPay, LNURLWithdraw,} from "./ClientSwapContract";
import {IntermediaryDiscovery} from "../intermediaries/IntermediaryDiscovery";
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
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
import {ChainUtils} from "../btc/ChainUtils";
import {MempoolBitcoinRpc} from "../btc/MempoolBitcoinRpc";
import {BtcRelay} from "crosslightning-base/dist";
import {MempoolBtcRelaySynchronizer} from "../btc/synchronizer/MempoolBtcRelaySynchronizer";
import {OutOfBoundsError} from "../errors/OutOfBoundsError";
import {IndexedDBWrapperStorage, Intermediary, LocalStorageManager} from "..";
import {LnForGasWrapper} from "./swapforgas/ln/LnForGasWrapper";
import {LnForGasSwap} from "./swapforgas/ln/LnForGasSwap";
import * as EventEmitter from "events";

export type SwapperOptions<T extends SwapData> = {
    intermediaryUrl?: string,
    //wbtcToken?: PublicKey,
    pricing?: ISwapPrice,
    registryUrl?: string,

    addresses?: {
        swapContract: string,
        btcRelayContract: string
    },
    bitcoinNetwork?: BitcoinNetwork,

    storage?: {
        toBtc?: IWrapperStorage,
        fromBtc?: IWrapperStorage,
        toBtcLn?: IWrapperStorage,
        fromBtcLn?: IWrapperStorage,
        lnForGas?: IStorageManager<LnForGasSwap<T>>
    },

    getRequestTimeout?: number,
    postRequestTimeout?: number,
    defaultTrustedIntermediaryUrl?: string
};

/**
 * Emits "swapState" event with swap object as a param
 */
export class Swapper<
    T extends SwapData,
    E extends ChainEvents<T>,
    P extends SwapContract<T, any, any, any>,
    TokenAddressType> extends EventEmitter {

    tobtcln: ToBTCLNWrapper<T>;
    tobtc: ToBTCWrapper<T>;
    frombtcln: FromBTCLNWrapper<T>;
    frombtc: FromBTCWrapper<T>;

    lnforgas: LnForGasWrapper<T>;

    readonly intermediaryDiscovery: IntermediaryDiscovery<T>;
    readonly clientSwapContract: ClientSwapContract<T>;
    readonly chainEvents: E;

    readonly swapContract: P;

    readonly bitcoinNetwork: bitcoin.Network;

    readonly options: SwapperOptions<T>;

    constructor(
        btcRelay: BtcRelay<any, any, any>,
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
                this.bitcoinNetwork = bitcoin.networks.bitcoin;
                ChainUtils.setMempoolUrl("https://mempool.space/api/", options.getRequestTimeout);
                break;
            case BitcoinNetwork.TESTNET:
                this.bitcoinNetwork = bitcoin.networks.testnet;
                ChainUtils.setMempoolUrl("https://mempool.space/testnet/api/", options.getRequestTimeout);
                break;
            case BitcoinNetwork.REGTEST:
                this.bitcoinNetwork = bitcoin.networks.regtest;
                break;
        }

        this.swapContract = swapContract;

        const synchronizer = new MempoolBtcRelaySynchronizer(btcRelay, bitcoinRpc);

        const clientSwapContract = new ClientSwapContract<T>(swapContract, swapDataConstructor, btcRelay, bitcoinRpc, null, options.pricing, {
            bitcoinNetwork: this.bitcoinNetwork,
            getRequestTimeout: options.getRequestTimeout,
            postRequestTimeout: options.postRequestTimeout
        });

        this.tobtcln = new ToBTCLNWrapper<T>(options.storage?.toBtcLn || new IndexedDBWrapperStorage(storagePrefix + "Swaps-ToBTCLN"), clientSwapContract, chainEvents, swapDataConstructor, this);
        this.tobtc = new ToBTCWrapper<T>(options.storage?.toBtc || new IndexedDBWrapperStorage(storagePrefix + "Swaps-ToBTC"), clientSwapContract, chainEvents, swapDataConstructor, this);
        this.frombtcln = new FromBTCLNWrapper<T>(options.storage?.fromBtcLn || new IndexedDBWrapperStorage(storagePrefix + "Swaps-FromBTCLN"), clientSwapContract, chainEvents, swapDataConstructor, this);
        this.frombtc = new FromBTCWrapper<T>(options.storage?.fromBtc || new IndexedDBWrapperStorage(storagePrefix + "Swaps-FromBTC"), clientSwapContract, chainEvents, swapDataConstructor, synchronizer, this);

        this.lnforgas = new LnForGasWrapper<T>(options.storage?.lnForGas || new LocalStorageManager<LnForGasSwap<T>>(storagePrefix + "LnForGas"), swapContract, options);

        this.chainEvents = chainEvents;
        this.clientSwapContract = clientSwapContract;

        if(options.intermediaryUrl!=null) {
            this.intermediaryDiscovery = new IntermediaryDiscovery<T>(swapContract, options.registryUrl, [options.intermediaryUrl], options.getRequestTimeout);
        } else {
            this.intermediaryDiscovery = new IntermediaryDiscovery<T>(swapContract, options.registryUrl, null, options.getRequestTimeout);
        }

        this.options = options;
    }


    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param address
     */
    isValidBitcoinAddress(address: string): boolean {
        try {
            bitcoin.address.toOutputScript(address, this.bitcoinNetwork);
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
            const parsed = bolt11.decode(lnpr);
            if(parsed.satoshis!=null) return true;
        } catch (e) {}
        return false;
    }

    /**
     * Returns true if string is a valid LNURL (no checking on type is performed)
     *
     * @param lnurl
     */
    isValidLNURL(lnurl: string): boolean {
        return this.clientSwapContract.isLNURL(lnurl);
    }

    /**
     * Returns type and data about an LNURL
     *
     * @param lnpr
     */
    getLNURLTypeAndData(lnurl: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null> {
        return this.clientSwapContract.getLNURLType(lnurl, shouldRetry);
    }

    /**
     * Returns satoshi value of BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    static getLightningInvoiceValue(lnpr: string): BN {
        const parsed = bolt11.decode(lnpr);
        if(parsed.satoshis!=null) return new BN(parsed.satoshis);
        return null;
    }

    getLightningInvoiceValue(lnpr: string): BN {
        return Swapper.getLightningInvoiceValue(lnpr);
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param kind      Type of the swap
     */
    getMaximum(kind: SwapType): BN {
        if(this.intermediaryDiscovery!=null) {
            const max = this.intermediaryDiscovery.getSwapMaximum(kind);
            if(max!=null) return new BN(max);
        }
        return new BN(0);
    }

    /**
     * Returns minimum possible swap amount
     *
     * @param kind      Type of swap
     */
    getMinimum(kind: SwapType): BN {
        if(this.intermediaryDiscovery!=null) {
            const min = this.intermediaryDiscovery.getSwapMinimum(kind);
            if(min!=null) return new BN(min);
        }
        return new BN(0);
    }

    /**
     * Initializes the swap storage and loads existing swaps
     * Needs to be called before any other action
     */
    async init() {
        await this.chainEvents.init();
        await this.clientSwapContract.init();

        console.log("Initializing To BTCLN");
        await this.tobtcln.init();
        console.log("Initializing To BTC");
        await this.tobtc.init();
        console.log("Initializing From BTCLN");
        await this.frombtcln.init();
        console.log("Initializing From BTC");
        await this.frombtc.init();

        console.log("Initializing LN for Gas");
        await this.lnforgas.init();

        if(this.intermediaryDiscovery!=null) {
            await this.intermediaryDiscovery.init();
        }
    }

    /**
     * Stops listening for onchain events and closes this Swapper instance
     */
    async stop() {
        await this.tobtcln.stop();
        await this.tobtc.stop();
        await this.frombtcln.stop();
        await this.frombtc.stop();
    }

    getSupportedTokens(swapType: SwapType): Set<string> {
        const set = new Set<string>();
        this.intermediaryDiscovery.intermediaries.forEach(lp => {
            if(lp.services[swapType]==null) return;
            lp.services[swapType].tokens.forEach(token => set.add(token));
        });
        return set;
    }

    async createSwap<S extends ISwap>(
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
            console.log("No valid intermediary found, reloading intermediary database...");
            await this.intermediaryDiscovery.reloadIntermediaries();
            console.log("Intermediaries loaded!");

            if(!inBtc) {
                //Get candidates not based on the amount
                candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token);
            } else {
                candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, amountData.token, amountData.amount);
            }

            if(candidates.length===0) throw new Error("No intermediary found!");
        }


        const abortController = new AbortController();
        console.log("[Swapper] Swap candidates: ", candidates);
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
                    console.error(data.intermediary.url+" error: ", e);
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

        console.log("Sorted quotes, best price to worst", quotes)

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
    createToBTCSwap(tokenAddress: TokenAddressType, address: string, amount: BN, confirmationTarget?: number, confirmations?: number, exactIn?: boolean, additionalParams?: Record<string, any>): Promise<ToBTCSwap<T>> {
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
    async createToBTCLNSwap(tokenAddress: TokenAddressType, paymentRequest: string, expirySeconds?: number, maxRoutingBaseFee?: BN, maxRoutingPPM?: BN, additionalParams?: Record<string, any>): Promise<ToBTCLNSwap<T>> {
        const parsedPR = bolt11.decode(paymentRequest);
        const amountData = {
            amount: new BN(parsedPR.millisatoshis).div(new BN(1000)),
            token: tokenAddress,
            exactIn: false
        };
        if(expirySeconds==null) expirySeconds = (3*24*3600);
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
    async createToBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurlPay: string | LNURLPay, amount: BN, comment: string, expirySeconds?: number, maxRoutingBaseFee?: BN, maxRoutingPPM?: BN, exactIn?: boolean, additionalParams?: Record<string, any>): Promise<ToBTCLNSwap<T>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn
        };
        if(expirySeconds==null) expirySeconds = (3*24*3600);
        return this.createSwap<ToBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => this.tobtcln.createViaLNURL(
                lnurlPay,
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
    async createFromBTCSwap(tokenAddress: TokenAddressType, amount: BN, exactOut?: boolean, additionalParams?: Record<string, any>): Promise<FromBTCSwap<T>> {
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
    async createFromBTCLNSwap(tokenAddress: TokenAddressType, amount: BN, exactOut?: boolean, descriptionHash?: Buffer, additionalParams?: Record<string, any>): Promise<FromBTCLNSwap<T>> {
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
    async createFromBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurl: string | LNURLWithdraw, amount: BN, additionalParams?: Record<string, any>): Promise<FromBTCLNSwap<T>> {
        const amountData = {
            amount,
            token: tokenAddress,
            exactIn: true
        };

        return this.createSwap<FromBTCLNSwap<T>>(
            (candidates: Intermediary[], abortSignal: AbortSignal) => this.frombtcln.createViaLNURL(
                lnurl,
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
     */
    createTrustedLNForGasSwap(amount: BN, trustedIntermediaryUrl?: string): Promise<LnForGasSwap<T>> {
        const useUrl = trustedIntermediaryUrl || this.options.defaultTrustedIntermediaryUrl;
        if(useUrl==null) throw new Error("No trusted intermediary URL specified!");
        return this.lnforgas.create(amount, useUrl+"/lnforgas");
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<ISwap[]> {
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
    async getActionableSwaps(): Promise<ISwap[]> {
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
    async getRefundableSwaps(): Promise<IToBTCSwap<T>[]> {
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

}