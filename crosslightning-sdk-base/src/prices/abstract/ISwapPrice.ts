import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";

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

    public async isValidAmountSend(amountSats: BN,satsBaseFee: BN, feePPM: BN, paidToken: BN, token: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<{
        isValid: boolean,
        differencePPM: BN,
        satsBaseFee: BN,
        feePPM: BN
    }> {
        if(this.shouldIgnore(token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM
        };

        const totalSats = amountSats.mul(new BN(1000000).add(feePPM)).div(new BN(1000000))
            .add(satsBaseFee);

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token, abortSignal, preFetchedPrice);

        console.log("Calculated amount in token: ", calculatedAmtInToken.toString(10));

        const difference = paidToken.sub(calculatedAmtInToken); //Will be >0 if we need to pay more than we should've

        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        if(differencePPM.gt(this.maxAllowedFeeDifferencePPM)) {
            return {
                isValid: false,
                differencePPM,
                satsBaseFee,
                feePPM
            };
        }

        return {
            isValid: true,
            differencePPM,
            satsBaseFee,
            feePPM
        };
    }

    public async isValidAmountReceive(amountSats: BN,satsBaseFee: BN, feePPM: BN, receiveToken: BN, token: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<{
        isValid: boolean,
        differencePPM: BN,
        satsBaseFee: BN,
        feePPM: BN
    }> {
        if(this.shouldIgnore(token)) return {
            isValid: true,
            differencePPM: new BN(0),
            satsBaseFee,
            feePPM
        };

        const totalSats = amountSats.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000))
            .sub(satsBaseFee);

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token, abortSignal, preFetchedPrice);

        console.log("Calculated amount in token: ", calculatedAmtInToken.toString(10));

        const difference = calculatedAmtInToken.sub(receiveToken); //Will be >0 if we receive less than we should've

        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        if(differencePPM.gt(this.maxAllowedFeeDifferencePPM)) {
            return {
                isValid: false,
                differencePPM,
                satsBaseFee,
                feePPM
            };
        }

        return {
            isValid: true,
            differencePPM,
            satsBaseFee,
            feePPM
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
     * @param fromAmount        Amount of the token
     * @param fromToken         Token
     * @param abortSignal
     * @param preFetchedPrice
     */
    public async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress, abortSignal?: AbortSignal, preFetchedPrice?: BN): Promise<BN> {
        if(this.getDecimals(fromToken.toString())==null) throw new Error("Token not found");

        const price = preFetchedPrice || await this.getPrice(fromToken, abortSignal);

        return fromAmount
            .mul(price)
            .div(new BN(1000000))
            .div(new BN(10).pow(new BN(this.getDecimals(fromToken.toString()))));
    }

    public shouldIgnore(tokenAddress: TokenAddress): boolean {
        const coin = this.getDecimals(tokenAddress.toString());
        if(coin==null) throw new Error("Token not found");
        return coin===-1;
    }

}
