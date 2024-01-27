import {BitcoinNetwork} from "../btc/BitcoinNetwork";
import {ISwapPrice} from "./ISwapPrice";
import {IWrapperStorage} from "../storage/IWrapperStorage";
import {ChainEvents, SwapContract, SwapData, TokenAddress} from "crosslightning-base";
import {ToBTCLNWrapper} from "./tobtc/ln/ToBTCLNWrapper";
import {ToBTCWrapper} from "./tobtc/onchain/ToBTCWrapper";
import {FromBTCLNWrapper} from "./frombtc/ln/FromBTCLNWrapper";
import {FromBTCWrapper} from "./frombtc/onchain/FromBTCWrapper";
import {
    ClientSwapContract,
    LNURLPay,
    LNURLPayParamsWithUrl,
    LNURLWithdraw,
    LNURLWithdrawParamsWithUrl
} from "./ClientSwapContract";
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
import {LocalWrapperStorage} from "../storage/LocalWrapperStorage";
import {OutOfBoundsError} from "../errors/OutOfBoundsError";
import {Intermediary} from "..";

export type SwapperOptions = {
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
        fromBtcLn?: IWrapperStorage
    },

    getRequestTimeout?: number,
    postRequestTimeout?: number
};

export class Swapper<
    T extends SwapData,
    E extends ChainEvents<T>,
    P extends SwapContract<T, any, any, any>,
    TokenAddressType> {

    tobtcln: ToBTCLNWrapper<T>;
    tobtc: ToBTCWrapper<T>;
    frombtcln: FromBTCLNWrapper<T>;
    frombtc: FromBTCWrapper<T>;

    readonly intermediaryDiscovery: IntermediaryDiscovery<T>;
    readonly clientSwapContract: ClientSwapContract<T>;
    readonly chainEvents: E;

    readonly swapContract: P;

    readonly bitcoinNetwork: bitcoin.Network;

    readonly options: SwapperOptions;

    constructor(
        btcRelay: BtcRelay<any, any, any>,
        bitcoinRpc: MempoolBitcoinRpc,
        swapContract: P,
        chainEvents: E,
        swapDataConstructor: new (data: any) => T,
        options: SwapperOptions,
        storagePrefix?: string
    ) {
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

        this.tobtcln = new ToBTCLNWrapper<T>(options.storage?.toBtcLn || new LocalWrapperStorage(storagePrefix + "Swaps-ToBTCLN"), clientSwapContract, chainEvents, swapDataConstructor);
        this.tobtc = new ToBTCWrapper<T>(options.storage?.toBtc || new LocalWrapperStorage(storagePrefix + "Swaps-ToBTC"), clientSwapContract, chainEvents, swapDataConstructor);
        this.frombtcln = new FromBTCLNWrapper<T>(options.storage?.fromBtcLn || new LocalWrapperStorage(storagePrefix + "Swaps-FromBTCLN"), clientSwapContract, chainEvents, swapDataConstructor);
        this.frombtc = new FromBTCWrapper<T>(options.storage?.fromBtc || new LocalWrapperStorage(storagePrefix + "Swaps-FromBTC"), clientSwapContract, chainEvents, swapDataConstructor, synchronizer);

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

    async createSwap<S extends ISwap>(create: (candidate: Intermediary) => Promise<S>, amount: BN, tokenAddress: TokenAddressType, inBtc: boolean, swapType: SwapType): Promise<S> {
        let candidates: Intermediary[];
        if(!inBtc) {
            //Get candidates not based on the amount
            candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, tokenAddress);
        } else {
            candidates = this.intermediaryDiscovery.getSwapCandidates(swapType, tokenAddress, amount);
        }
        if(candidates.length===0) throw new Error("No intermediary found!");

        let min: BN;
        let max: BN;

        let swap: S;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await create(candidate);
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
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
                console.error(e);
                error = e;
            }
        }

        if(min!=null && max!=null) {
            throw new OutOfBoundsError("Out of bounds", 400, min, max);
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
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
     */
    createToBTCSwap(tokenAddress: TokenAddressType, address: string, amount: BN, confirmationTarget?: number, confirmations?: number, exactIn?: boolean): Promise<ToBTCSwap<T>> {
        return this.createSwap<ToBTCSwap<T>>(
            (candidate: Intermediary) => this.tobtc.create(
                address,
                amount,
                confirmationTarget || 3,
                confirmations || 3,
                candidate.url+"/tobtc",
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.TO_BTC].swapBaseFee),
                new BN(candidate.services[SwapType.TO_BTC].swapFeePPM),
                exactIn
            ),
            amount,
            tokenAddress,
            !exactIn,
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
     */
    async createToBTCLNSwap(tokenAddress: TokenAddressType, paymentRequest: string, expirySeconds?: number, maxRoutingBaseFee?: BN, maxRoutingPPM?: BN): Promise<ToBTCLNSwap<T>> {
        const parsedPR = bolt11.decode(paymentRequest);

        return this.createSwap<ToBTCLNSwap<T>>(
            (candidate: Intermediary) => this.tobtcln.create(
                paymentRequest,
                expirySeconds || (3*24*3600),
                candidate.url+"/tobtcln",
                maxRoutingBaseFee,
                maxRoutingPPM,
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.TO_BTCLN].swapBaseFee),
                new BN(candidate.services[SwapType.TO_BTCLN].swapFeePPM)
            ),
            new BN(parsedPR.millisatoshis).div(new BN(1000)),
            tokenAddress,
            true,
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
     */
    async createToBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurlPay: string | LNURLPay, amount: BN, comment: string, expirySeconds?: number, maxRoutingBaseFee?: BN, maxRoutingPPM?: BN, exactIn?: boolean): Promise<ToBTCLNSwap<T>> {
        return this.createSwap<ToBTCLNSwap<T>>(
            (candidate: Intermediary) => this.tobtcln.createViaLNURL(
                lnurlPay,
                amount,
                comment,
                expirySeconds || (3*24*3600),
                candidate.url+"/tobtcln",
                maxRoutingBaseFee,
                maxRoutingPPM,
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.TO_BTCLN].swapBaseFee),
                new BN(candidate.services[SwapType.TO_BTCLN].swapFeePPM),
                exactIn
            ),
            amount,
            tokenAddress,
            !exactIn,
            SwapType.TO_BTCLN
        );
    }

    /**
     * Creates From BTC swap
     *
     * @param tokenAddress          Token address to receive
     * @param amount                Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param exactOut              Whether to use a exact out instead of exact in
     */
    async createFromBTCSwap(tokenAddress: TokenAddressType, amount: BN, exactOut?: boolean): Promise<FromBTCSwap<T>> {
        return this.createSwap<FromBTCSwap<T>>(
            (candidate: Intermediary) => this.frombtc.create(
                amount,
                candidate.url+"/frombtc",
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.FROM_BTC].swapBaseFee),
                new BN(candidate.services[SwapType.FROM_BTC].swapFeePPM),
                exactOut
            ),
            amount,
            tokenAddress,
            !exactOut,
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
     */
    async createFromBTCLNSwap(tokenAddress: TokenAddressType, amount: BN, exactOut?: boolean, descriptionHash?: Buffer): Promise<FromBTCLNSwap<T>> {
        return this.createSwap<FromBTCLNSwap<T>>(
            (candidate: Intermediary) => this.frombtcln.create(
                amount,
                candidate.url+"/frombtcln",
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.FROM_BTCLN].swapBaseFee),
                new BN(candidate.services[SwapType.FROM_BTCLN].swapFeePPM),
                exactOut,
                descriptionHash
            ),
            amount,
            tokenAddress,
            !exactOut,
            SwapType.FROM_BTCLN
        );
    }

    /**
     * Creates From BTCLN swap, withdrawing from LNURL-withdraw
     *
     * @param tokenAddress      Token address to receive
     * @param lnurl             LNURL-withdraw to pull the funds from
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param noInstantReceive  Flag to disable instantly posting the lightning PR to LN service for withdrawal, when set the lightning PR is sent to LN service when waitForPayment is called
     */
    async createFromBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurl: string | LNURLWithdraw, amount: BN, noInstantReceive?: boolean): Promise<FromBTCLNSwap<T>> {
        return this.createSwap<FromBTCLNSwap<T>>(
            (candidate: Intermediary) => this.frombtcln.createViaLNURL(
                lnurl,
                amount,
                candidate.url+"/frombtcln",
                tokenAddress,
                candidate.address,
                new BN(candidate.services[SwapType.FROM_BTCLN].swapBaseFee),
                new BN(candidate.services[SwapType.FROM_BTCLN].swapFeePPM),
                noInstantReceive
            ),
            amount,
            tokenAddress,
            true,
            SwapType.FROM_BTCLN
        );
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