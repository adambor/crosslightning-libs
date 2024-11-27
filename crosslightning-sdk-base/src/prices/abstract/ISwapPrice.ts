import * as BN from "bn.js";
import {ChainIds, MultiChain} from "../../swaps/Swapper";
import {Token} from "../../swaps/Tokens";

export type PriceInfoType = {
    isValid: boolean,
    differencePPM: BN,
    satsBaseFee: BN,
    feePPM: BN,
    realPriceUSatPerToken: BN,
    swapPriceUSatPerToken: BN
};

export function isPriceInfoType(obj: any): obj is PriceInfoType {
    return obj!=null &&
        typeof(obj.isValid) === "boolean" &&
        BN.isBN(obj.differencePPM) &&
        BN.isBN(obj.satsBaseFee) &&
        BN.isBN(obj.feePPM) &&
        BN.isBN(obj.realPriceUSatPerToken) &&
        BN.isBN(obj.swapPriceUSatPerToken);
}

export abstract class ISwapPrice<T extends MultiChain = MultiChain> {

    maxAllowedFeeDifferencePPM: BN;

    protected constructor(maxAllowedFeeDifferencePPM: BN) {
        this.maxAllowedFeeDifferencePPM = maxAllowedFeeDifferencePPM;
    }

    /**
     * Gets the decimal places for a given token, returns -1 if token should be ignored & null if token is not found
     * @param chainIdentifier
     * @param token
     * @protected
     */
    protected abstract getDecimals<C extends ChainIds<T>>(chainIdentifier: C, token: string): number | null;

    /**
     * Returns the price of the token in BTC uSats (microSats)
     *
     * @param chainIdentifier
     * @param token
     * @param abortSignal
     * @protected
     */
    protected abstract getPrice<C extends ChainIds<T>>(chainIdentifier: C, token: string, abortSignal?: AbortSignal): Promise<BN>;

    /**
     * Returns the price of bitcoin in USD, (sats/USD)
     *
     * @param abortSignal
     * @protected
     */
    protected abstract getUsdPrice(abortSignal?: AbortSignal): Promise<number>;

    /**
     * Recomputes pricing info without fetching the current price
     *
     * @param chainIdentifier
     * @param amountSats
     * @param satsBaseFee
     * @param feePPM
     * @param paidToken
     * @param token
     */
    public recomputePriceInfoSend<C extends ChainIds<T>>(
        chainIdentifier: C,
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        paidToken: BN,
        token: string
    ): PriceInfoType {
        const totalSats = amountSats.mul(new BN(1000000).add(feePPM)).div(new BN(1000000))
            .add(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(paidToken);

        return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: this.shouldIgnore(chainIdentifier, token) ? null : swapPriceUSatPerToken,
            swapPriceUSatPerToken
        };
    }

    /**
     * Checks whether the swap amounts are valid given the current market rate for a given pair
     *
     * @param chainIdentifier
     * @param amountSats Amount of sats (BTC) to be received from the swap
     * @param satsBaseFee Base fee in sats (BTC) as reported by the intermediary
     * @param feePPM PPM fee rate as reported by the intermediary
     * @param paidToken Amount of token to be paid to the swap
     * @param token
     * @param abortSignal
     * @param preFetchedPrice Already pre-fetched price
     */
    public async isValidAmountSend<C extends ChainIds<T>>(
        chainIdentifier: C,
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        paidToken: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        const totalSats = amountSats.mul(new BN(1000000).add(feePPM)).div(new BN(1000000))
            .add(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(paidToken);

        if(this.shouldIgnore(chainIdentifier, token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: null,
            swapPriceUSatPerToken
        };

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(chainIdentifier, totalSats, token, abortSignal, preFetchedPrice);
        const realPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(calculatedAmtInToken);

        const difference = paidToken.sub(calculatedAmtInToken); //Will be >0 if we need to pay more than we should've
        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        return {
            isValid: differencePPM.lte(this.maxAllowedFeeDifferencePPM),
            differencePPM,
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken,
            swapPriceUSatPerToken
        };
    }

    /**
     * Recomputes pricing info without fetching the current price
     *
     * @param chainIdentifier
     * @param amountSats
     * @param satsBaseFee
     * @param feePPM
     * @param receiveToken
     * @param token
     */
    public recomputePriceInfoReceive<C extends ChainIds<T>>(
        chainIdentifier: C,
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        receiveToken: BN,
        token: string,
    ): PriceInfoType {
        const totalSats = amountSats.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000))
            .sub(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(receiveToken);

        return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: this.shouldIgnore(chainIdentifier, token) ? null : swapPriceUSatPerToken,
            swapPriceUSatPerToken
        };
    }

    /**
     * Checks whether the swap amounts are valid given the current market rate for a given pair
     *
     * @param chainIdentifier
     * @param amountSats Amount of sats (BTC) to be paid to the swap
     * @param satsBaseFee Base fee in sats (BTC) as reported by the intermediary
     * @param feePPM PPM fee rate as reported by the intermediary
     * @param receiveToken Amount of token to be received from the swap
     * @param token
     * @param abortSignal
     * @param preFetchedPrice Already pre-fetched price
     */
    public async isValidAmountReceive<C extends ChainIds<T>>(
        chainIdentifier: C,
        amountSats: BN,
        satsBaseFee: BN,
        feePPM: BN,
        receiveToken: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        const totalSats = amountSats.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000))
            .sub(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(receiveToken);

        if(this.shouldIgnore(chainIdentifier, token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: null,
            swapPriceUSatPerToken
        };

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(chainIdentifier, totalSats, token, abortSignal, preFetchedPrice);
        const realPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, token)))).div(calculatedAmtInToken);

        const difference = calculatedAmtInToken.sub(receiveToken); //Will be >0 if we receive less than we should've
        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        return {
            isValid: differencePPM.lte(this.maxAllowedFeeDifferencePPM),
            differencePPM,
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken,
            swapPriceUSatPerToken
        };
    }

    public preFetchPrice<C extends ChainIds<T>>(chainIdentifier: C, token: string, abortSignal?: AbortSignal): Promise<BN> {
        return this.getPrice(chainIdentifier, token, abortSignal);
    }

    public preFetchUsdPrice(abortSignal?: AbortSignal): Promise<number> {
        return this.getUsdPrice(abortSignal);
    }

    /**
     * Returns amount of {toToken} that are equivalent to {fromAmount} satoshis
     *
     * @param chainIdentifier
     * @param fromAmount        Amount of satoshis
     * @param toToken           Token
     * @param abortSignal
     * @param preFetchedPrice
     * @throws {Error} when token is not found
     */
    public async getFromBtcSwapAmount<C extends ChainIds<T>>(
        chainIdentifier: C,
        fromAmount: BN,
        toToken: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<BN> {
        if(this.getDecimals(chainIdentifier, toToken.toString())==null) throw new Error("Token not found!");

        const price = preFetchedPrice || await this.getPrice(chainIdentifier, toToken, abortSignal);

        return fromAmount
            .mul(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, toToken.toString()))))
            .mul(new BN(1000000)) //To usat
            .div(price)
    }

    /**
     * Returns amount of satoshis that are equivalent to {fromAmount} of {fromToken}
     *
     * @param chainIdentifier
     * @param fromAmount Amount of the token
     * @param fromToken Token
     * @param abortSignal
     * @param preFetchedPrice Pre-fetched swap price if available
     * @throws {Error} when token is not found
     */
    public async getToBtcSwapAmount<C extends ChainIds<T>>(
        chainIdentifier: C,
        fromAmount: BN,
        fromToken: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<BN> {
        if(this.getDecimals(chainIdentifier, fromToken.toString())==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(chainIdentifier, fromToken, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000000))
            .div(new BN(10).pow(new BN(this.getDecimals(chainIdentifier, fromToken.toString()))));
    }

    /**
     * Returns whether the token should be ignored and pricing for it not calculated
     * @param chainIdentifier
     * @param tokenAddress
     * @throws {Error} if token is not found
     */
    public shouldIgnore<C extends ChainIds<T>>(chainIdentifier: C, tokenAddress: string): boolean {
        const coin = this.getDecimals(chainIdentifier, tokenAddress.toString());
        if(coin==null) throw new Error("Token not found");
        return coin===-1;
    }

    public async getBtcUsdValue(
        btcSats: BN,
        abortSignal?: AbortSignal,
        preFetchedPrice?: number
    ): Promise<number> {
        return btcSats.toNumber()*(preFetchedPrice || await this.getUsdPrice(abortSignal));
    }

    public async getTokenUsdValue<C extends ChainIds<T>>(
        chainId: C,
        tokenAmount: BN,
        token: string,
        abortSignal?: AbortSignal,
        preFetchedPrice?: number
    ): Promise<number> {
        const [btcAmount, usdPrice] = await Promise.all([
            this.getToBtcSwapAmount(chainId, tokenAmount, token, abortSignal),
            preFetchedPrice==null ? this.preFetchUsdPrice(abortSignal) : Promise.resolve(preFetchedPrice)
        ]);
        return btcAmount.toNumber()*usdPrice;
    }

    public getUsdValue<C extends ChainIds<T>>(
        amount: BN,
        token: Token<C>,
        abortSignal?: AbortSignal,
        preFetchedUsdPrice?: number
    ): Promise<number> {
        if(token.chain==="BTC") {
            return this.getBtcUsdValue(amount, abortSignal, preFetchedUsdPrice);
        } else {
            return this.getTokenUsdValue(token.chainId, amount, token.address, abortSignal, preFetchedUsdPrice);
        }
    }

}
