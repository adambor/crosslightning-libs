import * as bolt11 from "bolt11";
import {ToBTCLNSwap} from "./ToBTCLNSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {ClientSwapContract, LNURLPay, LNURLPayParamsWithUrl} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {UserError} from "../../../errors/UserError";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";

export class ToBTCLNWrapper<T extends SwapData> extends IToBTCWrapper<T> {

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T) {
        super(storage, contract, chainEvents, swapDataDeserializer);
    }

    private calculateFeeForAmount(amount: BN, overrideBaseFee?: BN, overrideFeePPM?: BN) : BN {
        return new BN(overrideBaseFee || this.contract.options.lightningBaseFee).add(amount.mul(new BN(overrideFeePPM || this.contract.options.lightningFeePPM)).div(new BN(1000000)));
    }

    init(): Promise<void> {
        return super.initWithConstructor(ToBTCLNSwap);
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param bolt11PayRequest  BOLT11 payment request (bitcoin lightning invoice) you wish to pay
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     * @param maxBaseFee        Max base fee for the payment routing
     * @param maxPPMFee         Max proportional fee PPM (per million 0.1% == 1000) for routing
     * @param requiredToken     Token that we want to send
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async create(
        bolt11PayRequest: string,
        expirySeconds: number,
        url: string,
        maxBaseFee?: BN,
        maxPPMFee?: BN,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCLNSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const parsedPR = bolt11.decode(bolt11PayRequest);

        if(parsedPR.satoshis==null) {
            throw new UserError("Must be an invoice with amount!");
        }

        const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));

        const fee = this.calculateFeeForAmount(sats, maxBaseFee, maxPPMFee);

        const result = await this.contract.payLightning(bolt11PayRequest, expirySeconds, fee, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM, null, null, null, null, null, null, null, additionalParams);

        const swap = new ToBTCLNSwap(
            this,
            bolt11PayRequest,
            result.data,
            result.maxFee,
            result.swapFee,
            result.prefix,
            result.timeout,
            result.signature,
            result.feeRate,
            url,
            result.confidence,
            result.routingFeeSats,
            result.expiry,
            result.pricingInfo
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }


    /**
     * Returns a newly created swap, paying for LNURL-pay
     *
     * @param lnurlPay          LNURL-pay link to use for payment
     * @param amount            Amount in sats to pay
     * @param comment           Optional comment for the payment request
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     * @param maxBaseFee        Max base fee for the payment routing
     * @param maxPPMFee         Max proportional fee PPM (per million 0.1% == 1000) for routing
     * @param requiredToken     Token that we want to send
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     * @param exactIn           Whether to do an exactIn swap instead of exactOut
     * @param additionalParams  Additional parameters sent to the LP when creating the swap
     */
    async createViaLNURL(
        lnurlPay: string | LNURLPay,
        amount: BN,
        comment: string,
        expirySeconds: number,
        url: string,
        maxBaseFee?: BN,
        maxPPMFee?: BN,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCLNSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        let fee: Promise<BN>;
        let pricePreFetch: Promise<BN>;
        if(exactIn && maxBaseFee==null) {
            pricePreFetch = this.contract.swapPrice.preFetchPrice(requiredToken);
            fee = pricePreFetch.then(val => {
                return this.contract.swapPrice.getFromBtcSwapAmount(new BN(this.contract.options.lightningBaseFee), requiredToken, null, val)
            }).then(_maxBaseFee => {
                return this.calculateFeeForAmount(amount, _maxBaseFee, maxPPMFee);
            });
        } else {
            fee = Promise.resolve(this.calculateFeeForAmount(amount, maxBaseFee, maxPPMFee));
        }

        const result = await this.contract.payLightningLNURL(
            typeof(lnurlPay)==="string" ? lnurlPay : lnurlPay.params,
            amount,
            comment,
            expirySeconds,
            fee,
            url,
            requiredToken,
            requiredKey,
            requiredBaseFee,
            requiredFeePPM,
            pricePreFetch,
            exactIn,
            additionalParams
        );

        const swap = new ToBTCLNSwap(
            this,
            result.invoice,
            result.data,
            result.maxFee,
            result.swapFee,
            result.prefix,
            result.timeout,
            result.signature,
            result.feeRate,
            url,
            result.confidence,
            result.routingFeeSats,
            result.expiry,
            result.pricingInfo,
            typeof(lnurlPay)==="string" ? lnurlPay : lnurlPay.params.url,
            result.successAction
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

}
