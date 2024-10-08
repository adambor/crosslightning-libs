import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";

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

export abstract class ISwapPrice {

    maxAllowedFeeDifferencePPM: BN;

    protected constructor(maxAllowedFeeDifferencePPM: BN) {
        this.maxAllowedFeeDifferencePPM = maxAllowedFeeDifferencePPM;
    }

    /**
     * Gets the decimal places for a given token, returns -1 if token should be ignored & null if token is not found
     * @param token
     * @protected
     */
    protected abstract getDecimals(token: TokenAddress): number | null;

    /**
     * Returns the price of the token in BTC uSats (microSats)
     *
     * @param token
     * @param abortSignal
     * @protected
     */
    protected abstract getPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN>;

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
        token: TokenAddress,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        const totalSats = amountSats.mul(new BN(1000000).add(feePPM)).div(new BN(1000000))
            .add(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(token)))).div(paidToken);

        if(this.shouldIgnore(token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: null,
            swapPriceUSatPerToken
        };

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token, abortSignal, preFetchedPrice);
        const realPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(token)))).div(calculatedAmtInToken);

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
        token: TokenAddress,
        abortSignal?: AbortSignal,
        preFetchedPrice?: BN
    ): Promise<PriceInfoType> {
        const totalSats = amountSats.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000))
            .sub(satsBaseFee);
        const totalUSats = totalSats.mul(new BN(1000000));
        const swapPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(token)))).div(receiveToken);

        if(this.shouldIgnore(token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM,
            realPriceUSatPerToken: null,
            swapPriceUSatPerToken
        };

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token, abortSignal, preFetchedPrice);
        const realPriceUSatPerToken = totalUSats.mul(new BN(10).pow(new BN(this.getDecimals(token)))).div(calculatedAmtInToken);

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

    public preFetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
        return this.getPrice(token, abortSignal);
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
    public async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        if(this.getDecimals(toToken.toString())==null) throw new Error("Token not found!");

        const price = preFetchedPrice || await this.getPrice(toToken, abortSignal);

        return fromAmount
            .mul(new BN(10).pow(new BN(this.getDecimals(toToken.toString()))))
            .mul(new BN(1000000)) //To usat
            .div(price)
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
    public async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        if(this.getDecimals(fromToken.toString())==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(fromToken, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000000))
            .div(new BN(10).pow(new BN(this.getDecimals(fromToken.toString()))));
    }

    /**
     * Returns whether the token should be ignored and pricing for it not calculated
     * @param tokenAddress
     * @throws {Error} if token is not found
     */
    public shouldIgnore(tokenAddress: TokenAddress): boolean {
        const coin = this.getDecimals(tokenAddress.toString());
        if(coin==null) throw new Error("Token not found");
        return coin===-1;
    }

}
