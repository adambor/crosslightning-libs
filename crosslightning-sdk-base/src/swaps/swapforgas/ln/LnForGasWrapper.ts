import * as BN from "bn.js";
import {LnForGasSwap, LnForGasSwapInit, LnForGasSwapState} from "./LnForGasSwap";
import {ISwapWrapper} from "../../ISwapWrapper";
import {TrustedIntermediaryAPI} from "../../../intermediaries/TrustedIntermediaryAPI";
import {decode as bolt11Decode} from "bolt11";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {ChainType} from "crosslightning-base";

export class LnForGasWrapper<T extends ChainType> extends ISwapWrapper<T, LnForGasSwap<T>> {
    protected readonly swapDeserializer = LnForGasSwap;

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param signer
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(signer: string, amount: BN, url: string): Promise<LnForGasSwap<T>> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const resp = await TrustedIntermediaryAPI.initTrustedFromBTCLN(url, {
            address: signer,
            amount
        }, this.options.getRequestTimeout);

        const decodedPr = bolt11Decode(resp.pr);
        const amountIn = new BN(decodedPr.millisatoshis).add(new BN(999)).div(new BN(1000));

        if(!resp.total.eq(amount)) throw new IntermediaryError("Invalid total returned");

        const pricingInfo = await this.verifyReturnedPrice(
            {swapFeePPM: 10000, swapBaseFee: 10}, false, amountIn,
            amount, this.contract.getNativeCurrencyAddress(), resp
        );

        const quote = new LnForGasSwap(this, {
            pr: resp.pr,
            outputAmount: resp.total,
            recipient: signer,
            pricingInfo,
            url,
            expiry: decodedPr.timeExpireDate*1000,
            swapFee: resp.swapFee,
            feeRate: "",
            exactIn: false
        } as LnForGasSwapInit<T["Data"]>);
        await quote._save();
        return quote;
    }

    protected async checkPastSwap(swap: LnForGasSwap<T>): Promise<boolean> {
        if(swap.state===LnForGasSwapState.PR_CREATED) {
            //Check if it's maybe already paid
            const res = await swap.checkInvoicePaid(false);
            if(res!==null) return true;

            if(swap.getTimeoutTime()<Date.now()) {
                swap.state = LnForGasSwapState.EXPIRED;
                return true;
            }
        }
        return false;
    }

    protected isOurSwap(signer: string, swap: LnForGasSwap<T>): boolean {
        return signer===swap.getRecipient();
    }

    protected tickSwap(swap: LnForGasSwap<T>): void {}

}
