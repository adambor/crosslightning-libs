import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";

export abstract class ISwapPrice {

    maxAllowedFeeDifferencePPM: BN;

    protected constructor(maxAllowedFeeDifferencePPM: BN) {
        this.maxAllowedFeeDifferencePPM = maxAllowedFeeDifferencePPM;
    }

    async isValidAmountSend(amountSats: BN,satsBaseFee: BN, feePPM: BN, paidToken: BN, token: TokenAddress): Promise<boolean> {
        const totalSats = amountSats.mul(new BN(1000000).add(feePPM)).div(new BN(1000000))
            .add(satsBaseFee);

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token);

        console.log("Calculated amount in token: ", calculatedAmtInToken.toString(10));

        const difference = paidToken.sub(calculatedAmtInToken); //Will be >0 if we need to pay more than we should've

        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        if(differencePPM.gt(this.maxAllowedFeeDifferencePPM)) {
            return false;
        }

        return true;
    }

    async isValidAmountReceive(amountSats: BN,satsBaseFee: BN, feePPM: BN, receiveToken: BN, token: TokenAddress): Promise<boolean> {
        const totalSats = amountSats.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000))
            .sub(satsBaseFee);

        const calculatedAmtInToken = await this.getFromBtcSwapAmount(totalSats, token);

        console.log("Calculated amount in token: ", calculatedAmtInToken.toString(10));

        const difference = calculatedAmtInToken.sub(receiveToken); //Will be >0 if we receive less than we should've

        const differencePPM = difference.mul(new BN(1000000)).div(calculatedAmtInToken);

        if(differencePPM.gt(this.maxAllowedFeeDifferencePPM)) {
            return false;
        }

        return true;
    }

    /**
     * Returns amount of satoshis that are equivalent to {fromAmount} of {fromToken}
     *
     * @param fromAmount        Amount of the token
     * @param fromToken         Token
     */
    abstract getToBtcSwapAmount(fromAmount:BN, fromToken: TokenAddress): Promise<BN>;

    /**
     * Returns amount of {toToken} that are equivalent to {fromAmount} satoshis
     *
     * @param fromAmount        Amount of satoshis
     * @param toToken           Token
     */
    abstract getFromBtcSwapAmount(fromAmount:BN, toToken: TokenAddress): Promise<BN>;

}
