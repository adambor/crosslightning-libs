import { BitcoinNetwork } from "../btc/BitcoinNetwork";
import {ISwapPrice} from "./ISwapPrice";
import {IWrapperStorage} from "../storage/IWrapperStorage";
import {ChainEvents, SwapContract, SwapData} from "crosslightning-base";
import {ToBTCLNWrapper} from "./tobtc/ln/ToBTCLNWrapper";
import {ToBTCWrapper} from "./tobtc/onchain/ToBTCWrapper";
import {FromBTCLNWrapper} from "./frombtc/ln/FromBTCLNWrapper";
import {FromBTCWrapper} from "./frombtc/onchain/FromBTCWrapper";
import {ClientSwapContract, LNURLPay, LNURLWithdraw} from "./ClientSwapContract";
import {IntermediaryDiscovery} from "../intermediaries/IntermediaryDiscovery";
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
import BN from "bn.js";
import { IFromBTCSwap } from "./frombtc/IFromBTCSwap";
import {IToBTCSwap} from "./tobtc/IToBTCSwap";
import { ISwap } from "./ISwap";
import { IntermediaryError } from "../errors/IntermediaryError";
import {SwapType} from "./SwapType";
import { FromBTCLNSwap } from "./frombtc/ln/FromBTCLNSwap";
import { FromBTCSwap } from "./frombtc/onchain/FromBTCSwap";
import { ToBTCLNSwap } from "./tobtc/ln/ToBTCLNSwap";
import { ToBTCSwap } from "./tobtc/onchain/ToBTCSwap";

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
    }
};

export class Swapper<
    T extends SwapData,
    E extends ChainEvents<T>,
    P extends SwapContract<T, any>,
    TokenAddressType> {

    tobtcln: ToBTCLNWrapper<T>;
    tobtc: ToBTCWrapper<T>;
    frombtcln: FromBTCLNWrapper<T>;
    frombtc: FromBTCWrapper<T>;

    private readonly intermediaryDiscovery: IntermediaryDiscovery<T>;
    private readonly clientSwapContract: ClientSwapContract<T>;
    private readonly chainEvents: E;

    private readonly swapContract: P;

    private readonly bitcoinNetwork: bitcoin.Network;


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
    getLNURLTypeAndData(lnurl: string): Promise<LNURLPay | LNURLWithdraw | null> {
        return this.clientSwapContract.getLNURLType(lnurl);
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

    /**
     * Creates To BTC swap
     *
     * @param tokenAddress          Token address to pay with
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in satoshis (bitcoin's smallest denomination)
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     */
    async createToBTCSwap(tokenAddress: TokenAddressType, address: string, amount: BN, confirmationTarget?: number, confirmations?: number): Promise<ToBTCSwap<T>> {
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTC, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.tobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, candidate.url+"/tobtc", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTC].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTC].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
                error = e;
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
    }


    /**
     * Creates To BTC swap with exactly specified input token amount
     *
     * @param tokenAddress          Token address to pay with
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in token base units
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     */
    async createToBTCSwapExactIn(tokenAddress: string, address: string, amount: BN, confirmationTarget?: number, confirmations?: number): Promise<ToBTCSwap<T>> {
        const candidates = await this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTC, amount, tokenAddress);

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.tobtc.createExactIn(address, amount, confirmationTarget || 3, confirmations || 3, candidate.url+"/tobtc", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTC].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTC].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
                error = e;
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
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
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTCLN, new BN(parsedPR.millisatoshis).div(new BN(1000)), tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.tobtcln.create(paymentRequest, expirySeconds || (3*24*3600), candidate.url+"/tobtcln", maxRoutingBaseFee, maxRoutingPPM, tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
                error = e;
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
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
     */
    async createToBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurlPay: string, amount: BN, comment: string, expirySeconds?: number, maxRoutingBaseFee?: BN, maxRoutingPPM?: BN): Promise<ToBTCLNSwap<T>> {
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTCLN, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.tobtcln.createViaLNURL(lnurlPay, amount, comment, expirySeconds || (3*24*3600), candidate.url+"/tobtcln", maxRoutingBaseFee, maxRoutingPPM, tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
                error = e;
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }


        return swap;
    }

    /**
     * Creates From BTC swap
     *
     * @param tokenAddress          Token address to receive
     * @param amount                Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    async createFromBTCSwap(tokenAddress: TokenAddressType, amount: BN): Promise<FromBTCSwap<T>> {
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.FROM_BTC, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.frombtc.create(amount, candidate.url+"/frombtc", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.FROM_BTC].swapBaseFee),
                    new BN(candidate.services[SwapType.FROM_BTC].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
                error = e;
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }


        return swap;
    }

    /**
     * Creates From BTCLN swap
     *
     * @param tokenAddress      Token address to receive
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param invoiceExpiry     Lightning invoice expiry time (in seconds)
     */
    async createFromBTCLNSwap(tokenAddress: TokenAddressType, amount: BN, invoiceExpiry?: number): Promise<FromBTCLNSwap<T>> {
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.FROM_BTCLN, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");


        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.frombtcln.create(amount, invoiceExpiry || (1*24*3600), candidate.url+"/frombtcln", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                error = e;
                console.error(e);
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
    }

    /**
     * Creates From BTCLN swap, withdrawing from LNURL-withdraw
     *
     * @param tokenAddress      Token address to receive
     * @param lnurl             LNURL-withdraw to pull the funds from
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param invoiceExpiry     Lightning invoice expiry time (in seconds)
     */
    async createFromBTCLNSwapViaLNURL(tokenAddress: TokenAddressType, lnurl: string, amount: BN, invoiceExpiry?: number): Promise<FromBTCLNSwap<T>> {
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.FROM_BTCLN, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        let error;
        for(let candidate of candidates) {
            try {
                swap = await this.frombtcln.createViaLNURL(lnurl, amount, invoiceExpiry || (1*24*3600), candidate.url+"/frombtcln", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                error = e;
                console.error(e);
            }
        }

        if(swap==null) {
            if(error!=null) throw error;
            throw new Error("No intermediary found!");
        }

        return swap;
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