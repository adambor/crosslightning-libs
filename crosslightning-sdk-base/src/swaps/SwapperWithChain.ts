import {LNURLPay, LNURLWithdraw} from "../utils/LNURL";
import * as BN from "bn.js";
import {IntermediaryDiscovery, SwapBounds} from "../intermediaries/IntermediaryDiscovery";
import {SwapType} from "./SwapType";
import {LnForGasSwap} from "./swapforgas/ln/LnForGasSwap";
import {ISwap} from "./ISwap";
import {IToBTCSwap} from "./tobtc/IToBTCSwap";
import {IFromBTCSwap} from "./frombtc/IFromBTCSwap";
import {ChainIds, MultiChain, Swapper, SwapperBtcUtils, SwapperOptions} from "./Swapper";
import {FromBTCLNSwap} from "./frombtc/ln/FromBTCLNSwap";
import {Buffer} from "buffer";
import {FromBTCSwap} from "./frombtc/onchain/FromBTCSwap";
import {ToBTCLNSwap} from "./tobtc/ln/ToBTCLNSwap";
import {ToBTCSwap} from "./tobtc/onchain/ToBTCSwap";
import {SwapperWithSigner} from "./SwapperWithSigner";
import {SwapPriceWithChain} from "../prices/SwapPriceWithChain";
import {MempoolApi} from "../btc/mempool/MempoolApi";
import {MempoolBitcoinRpc} from "../btc/mempool/MempoolBitcoinRpc";
import {Network} from "bitcoinjs-lib";
import {BtcToken, SCToken, Token} from "./Tokens";

export class SwapperWithChain<T extends MultiChain, ChainIdentifier extends ChainIds<T>> implements SwapperBtcUtils {

    readonly chainIdentifier: ChainIdentifier;
    readonly swapper: Swapper<T>;

    readonly prices: SwapPriceWithChain<T, ChainIdentifier>;

    get intermediaryDiscovery(): IntermediaryDiscovery {
        return this.swapper.intermediaryDiscovery;
    }
    get mempoolApi(): MempoolApi {
        return this.swapper.mempoolApi;
    }
    get bitcoinRpc(): MempoolBitcoinRpc {
        return this.swapper.bitcoinRpc;
    }
    get bitcoinNetwork(): Network {
        return this.swapper.bitcoinNetwork;
    }

    constructor(swapper: Swapper<T>, chainIdentifier: ChainIdentifier) {
        this.swapper = swapper;
        this.chainIdentifier = chainIdentifier;
        this.prices = new SwapPriceWithChain<T, ChainIdentifier>(swapper.prices, chainIdentifier);
    }

    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param addr
     */
    isValidBitcoinAddress(addr: string): boolean {
        return this.swapper.isValidBitcoinAddress(addr);
    }

    /**
     * Returns true if string is a valid BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    isValidLightningInvoice(lnpr: string): boolean {
        return this.swapper.isValidLightningInvoice(lnpr);
    }

    /**
     * Returns true if string is a valid LNURL (no checking on type is performed)
     *
     * @param lnurl
     */
    isValidLNURL(lnurl: string): boolean {
        return this.swapper.isValidLNURL(lnurl);
    }

    /**
     * Returns type and data about an LNURL
     *
     * @param lnurl
     * @param shouldRetry
     */
    getLNURLTypeAndData(lnurl: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null> {
        return this.swapper.getLNURLTypeAndData(lnurl, shouldRetry);
    }

    /**
     * Returns satoshi value of BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    getLightningInvoiceValue(lnpr: string): BN {
        return this.swapper.getLightningInvoiceValue(lnpr);
    }

    /**
     * Returns swap bounds (minimums & maximums) for different swap types & tokens
     */
    getSwapBounds(): SwapBounds {
        return this.swapper.getSwapBounds(this.chainIdentifier);
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param type      Type of the swap
     * @param token     Token of the swap
     */
    getMaximum(type: SwapType, token: string): BN {
        return this.swapper.getMaximum(this.chainIdentifier, type, token);
    }

    /**
     * Returns minimum possible swap amount
     *
     * @param type      Type of swap
     * @param token     Token of the swap
     */
    getMinimum(type: SwapType, token: string): BN {
        return this.swapper.getMinimum(this.chainIdentifier, type, token);
    }

    /**
     * Returns a set of supported tokens by all the intermediaries offering a specific swap service
     *
     * @param swapType Swap service type to check supported tokens for
     */
    getSupportedTokens(swapType: SwapType): SCToken[] {
        const arr: SCToken[] = [];
        this.getSupportedTokenAddresses(swapType).forEach(tokenAddress => {
            const token = this.swapper.tokens?.[this.chainIdentifier]?.[tokenAddress];
            if(token!=null) arr.push(token);
        });
        return arr;
    }

    /**
     * Returns the set of supported tokens by all the intermediaries we know of offering a specific swapType service
     *
     * @param swapType Specific swap type for which to obtain supported tokens
     */
    getSupportedTokenAddresses(swapType: SwapType): Set<string> {
        return this.swapper.getSupportedTokenAddresses(this.chainIdentifier, swapType);
    }

    createToBTCSwap(
        signer: string,
        tokenAddress: string,
        address: string,
        amount: BN,
        confirmationTarget?: number,
        confirmations?: number,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCSwap<T[ChainIdentifier]>> {
        return this.swapper.createToBTCSwap(this.chainIdentifier, signer, tokenAddress, address, amount, confirmationTarget, confirmations, exactIn, additionalParams);
    }

    createToBTCLNSwap(
        signer: string,
        tokenAddress: string,
        paymentRequest: string,
        expirySeconds?: number,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCLNSwap<T[ChainIdentifier]>> {
        return this.swapper.createToBTCLNSwap(this.chainIdentifier, signer, tokenAddress, paymentRequest, expirySeconds, maxRoutingBaseFee, maxRoutingPPM, additionalParams);
    }

    createToBTCLNSwapViaLNURL(
        signer: string,
        tokenAddress: string,
        lnurlPay: string | LNURLPay,
        amount: BN,
        comment: string,
        expirySeconds?: number,
        maxRoutingBaseFee?: BN,
        maxRoutingPPM?: BN,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCLNSwap<T[ChainIdentifier]>> {
        return this.swapper.createToBTCLNSwapViaLNURL(this.chainIdentifier, signer, tokenAddress, lnurlPay, amount, comment, expirySeconds, maxRoutingBaseFee, maxRoutingPPM, exactIn, additionalParams);
    }

    createFromBTCSwap(
        signer: string,
        tokenAddress: string,
        amount: BN,
        exactOut?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<FromBTCSwap<T[ChainIdentifier]>> {
        return this.swapper.createFromBTCSwap(this.chainIdentifier, signer, tokenAddress, amount, exactOut, additionalParams);
    }

    createFromBTCLNSwap(
        signer: string,
        tokenAddress: string,
        amount: BN,
        exactOut?: boolean,
        descriptionHash?: Buffer,
        additionalParams?: Record<string, any>
    ): Promise<FromBTCLNSwap<T[ChainIdentifier]>> {
        return this.swapper.createFromBTCLNSwap(this.chainIdentifier, signer, tokenAddress, amount, exactOut, descriptionHash, additionalParams);
    }

    createFromBTCLNSwapViaLNURL(
        signer: string,
        tokenAddress: string,
        lnurl: string | LNURLWithdraw,
        amount: BN,
        exactOut?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<FromBTCLNSwap<T[ChainIdentifier]>> {
        return this.swapper.createFromBTCLNSwapViaLNURL(this.chainIdentifier, signer, tokenAddress, lnurl, amount, exactOut, additionalParams);
    }

    createTrustedLNForGasSwap(signer: string, amount: BN, trustedIntermediaryUrl?: string): Promise<LnForGasSwap<T[ChainIdentifier]>> {
        return this.swapper.createTrustedLNForGasSwap(this.chainIdentifier, signer, amount, trustedIntermediaryUrl);
    }

    create(signer: string, srcToken: BtcToken<true>, dstToken: SCToken<ChainIdentifier>, amount: BN, exactIn: boolean, lnurlWithdraw?: string): Promise<FromBTCLNSwap<T[ChainIdentifier]>>;
    create(signer: string, srcToken: BtcToken<false>, dstToken: SCToken<ChainIdentifier>, amount: BN, exactIn: boolean): Promise<FromBTCSwap<T[ChainIdentifier]>>;
    create(signer: string, srcToken: SCToken<ChainIdentifier>, dstToken: BtcToken<false>, amount: BN, exactIn: boolean, address: string): Promise<ToBTCSwap<T[ChainIdentifier]>>;
    create(signer: string, srcToken: SCToken<ChainIdentifier>, dstToken: BtcToken<true>, amount: BN, exactIn: boolean, lnurlPay: string): Promise<ToBTCLNSwap<T[ChainIdentifier]>>;
    create(signer: string, srcToken: SCToken<ChainIdentifier>, dstToken: BtcToken<true>, amount: BN, exactIn: false, lightningInvoice: string): Promise<ToBTCLNSwap<T[ChainIdentifier]>>;
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
    create(signer: string, srcToken: Token<ChainIdentifier>, dstToken: Token<ChainIdentifier>, amount: BN, exactIn: boolean, addressLnurlLightningInvoice?: string): Promise<ISwap<T[ChainIdentifier]>> {
        return this.swapper.create(signer, srcToken as any, dstToken as any, amount, exactIn, addressLnurlLightningInvoice);
    }

    /**
     * Returns swaps that are in-progress and are claimable for the specific chain, optionally also for a specific signer's address
     */
    getAllSwaps(signer?: string): Promise<ISwap<T[ChainIdentifier]>[]> {
        return this.swapper.getAllSwaps(this.chainIdentifier, signer);
    }

    /**
     * Returns swaps that are in-progress and are claimable for the specific chain, optionally also for a specific signer's address
     */
    getActionableSwaps(signer?: string): Promise<ISwap<T[ChainIdentifier]>[]> {
        return this.swapper.getActionableSwaps(this.chainIdentifier, signer);
    }

    /**
     * Returns swaps that are in-progress and are claimable for the specific chain, optionally also for a specific signer's address
     */
    getRefundableSwaps(signer?: string): Promise<IToBTCSwap<T[ChainIdentifier]>[]> {
        return this.swapper.getRefundableSwaps(this.chainIdentifier, signer);
    }

    /**
     * Returns swaps that are in-progress and are claimable for the specific chain, optionally also for a specific signer's address
     */
    getClaimableSwaps(signer?: string): Promise<IFromBTCSwap<T[ChainIdentifier]>[]> {
        return this.swapper.getClaimableSwaps(this.chainIdentifier, signer);
    }

    /**
     * Returns the token balance of the wallet
     */
    getBalance(signer: string, token: string | SCToken<ChainIdentifier>): Promise<BN> {
        let tokenAddress: string;
        if(typeof(token) === 'string') {
            tokenAddress = token;
        } else {
            if(this.chainIdentifier!==token.chainId) throw new Error("Invalid token, chainId mismatch!");
            tokenAddress = token.address;
        }
        return this.swapper.getBalance(this.chainIdentifier, signer, tokenAddress);
    }

    /**
     * Returns the native token balance of the wallet
     */
    getNativeBalance(signer: string): Promise<BN> {
        return this.swapper.getNativeBalance(this.chainIdentifier, signer);
    }

    /**
     * Returns the address of the native token of the chain
     */
    getNativeToken(): SCToken<ChainIdentifier> {
        return this.swapper.getNativeToken(this.chainIdentifier);
    }

    /**
     * Returns the address of the native token's address of the chain
     */
    getNativeTokenAddress(): string {
        return this.swapper.getNativeTokenAddress(this.chainIdentifier);
    }

    withSigner(signer: T[ChainIdentifier]["Signer"]) {
        return new SwapperWithSigner<T, ChainIdentifier>(this, signer);
    }

    randomSigner(): T[ChainIdentifier]["Signer"] {
        return this.swapper.randomSigner(this.chainIdentifier);
    }

}
