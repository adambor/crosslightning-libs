import {ISwapPrice, PriceInfoType} from "./abstract/ISwapPrice";
import {ChainIds, MultiChain} from "../swaps/Swapper";
import * as BN from "bn.js";
import {Token} from "../swaps/Tokens";

export class SwapPriceWithChain<T extends MultiChain, ChainIdentifier extends ChainIds<T>> {

    swapPrice: ISwapPrice<T>;
    chainIdentifier: ChainIdentifier;

    maxAllowedFeeDifferencePPM: BN;

    constructor(swapPrice: ISwapPrice<T>, chainIdentifier: ChainIdentifier) {
        this.swapPrice = swapPrice;
        this.chainIdentifier = chainIdentifier;
    }

    /**
     * Checks whether the swap amounts are valid given the current market rate for a given pair
     *
     * @param amountSats Amount of sats (BTC) to be received from the swap
     * @param satsBaseFee Base fee in sats (BTC) as reported by the intermediary
     * @param feePPM PPM fee rate as reported by the intermediary
     * @param paidToken Amount of token to be paid to the swap
     * @param token
     * @param abortSignal
     * @param preFetchedPrice Already pre-fetched price
     */
    public async isValidAmountSend(
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        paidToken: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        return this.swapPrice.isValidAmountSend<ChainIdentifier>(
            this.chainIdentifier, amountSats, satsBaseFee, feePPM, paidToken, token, abortSignal, preFetchedPrice
        );
    }

    /**
     * Checks whether the swap amounts are valid given the current market rate for a given pair
     *
     * @param amountSats Amount of sats (BTC) to be paid to the swap
     * @param satsBaseFee Base fee in sats (BTC) as reported by the intermediary
     * @param feePPM PPM fee rate as reported by the intermediary
     * @param receiveToken Amount of token to be received from the swap
     * @param token
     * @param abortSignal
     * @param preFetchedPrice Already pre-fetched price
     */
    public async isValidAmountReceive(
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        receiveToken: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        return this.swapPrice.isValidAmountReceive<ChainIdentifier>(
            this.chainIdentifier, amountSats, satsBaseFee, feePPM, receiveToken, token, abortSignal, preFetchedPrice
        );
    }

    public preFetchPrice(token: string, abortSignal?: AbortSignal): Promise<BN> {
        return this.swapPrice.preFetchPrice<ChainIdentifier>(this.chainIdentifier, token, abortSignal);
    }

    public preFetchUsdPrice(abortSignal?: AbortSignal): Promise<number> {
        return this.swapPrice.preFetchUsdPrice(abortSignal);
    }

    /**
     * Returns amount of {toToken} that are equivalent to {fromAmount} satoshis
     *
     * @param fromAmount        Amount of satoshis
     * @param toToken           Token
     * @param abortSignal
     * @param preFetchedPrice
     * @throws {Error} when token is not found
     */
    public async getFromBtcSwapAmount(
        fromAmount: BN,
        toToken: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<BN> {
        return this.swapPrice.getFromBtcSwapAmount<ChainIdentifier>(
            this.chainIdentifier, fromAmount, toToken, abortSignal, preFetchedPrice
        );
    }

    /**
     * Returns amount of satoshis that are equivalent to {fromAmount} of {fromToken}
     *
     * @param fromAmount Amount of the token
     * @param fromToken Token
     * @param abortSignal
     * @param preFetchedPrice Pre-fetched swap price if available
     * @throws {Error} when token is not found
     */
    public async getToBtcSwapAmount(
        fromAmount: BN,
        fromToken: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<BN> {
        return this.swapPrice.getToBtcSwapAmount<ChainIdentifier>(
            this.chainIdentifier, fromAmount, fromToken, abortSignal, preFetchedPrice
        );
    }

    /**
     * Returns whether the token should be ignored and pricing for it not calculated
     *
     * @param tokenAddress
     * @throws {Error} if token is not found
     */
    public shouldIgnore(tokenAddress: string): boolean {
        return this.swapPrice.shouldIgnore<ChainIdentifier>(this.chainIdentifier, tokenAddress);
    }

    public async getBtcUsdValue(
        btcSats: BN,
        abortSignal?: AbortSignal,
        preFetchedPrice?: number
    ): Promise<number> {
        return this.swapPrice.getBtcUsdValue(btcSats, abortSignal, preFetchedPrice);
    }

    public async getTokenUsdValue(
        tokenAmount: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: number
    ): Promise<number> {
        return this.swapPrice.getTokenUsdValue(this.chainIdentifier, tokenAmount, token, abortSignal, preFetchedPrice);
    }

    public getUsdValue(
        amount: BN,
        token: Token<ChainIdentifier>,
        abortSignal?: AbortSignal,
        preFetchedUsdPrice?: number
    ): Promise<number> {
        return this.swapPrice.getUsdValue(amount, token, abortSignal, preFetchedUsdPrice);
    }

}
