import * as bolt11 from "bolt11";
import {ToBTCLNSwap} from "./ToBTCLNSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {AmountData, ClientSwapContract, LNURLPay, LNURLPayParamsWithUrl} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {UserError} from "../../../errors/UserError";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";
import * as EventEmitter from "events";
import {Intermediary} from "../../../intermediaries/Intermediary";
import {ToBTCOptions} from "../onchain/ToBTCWrapper";
import * as dns from "node:dns";

export type ToBTCLNOptions = {
    expirySeconds: number,
    maxFee?: BN,
    reqId?: string,
    requiredTotal?: BN,
    expiryTimestamp?: BN,
}

export class ToBTCLNWrapper<T extends SwapData> extends IToBTCWrapper<T> {

    /**
     * @param storage                   Storage interface for the current environment
     * @param contract                  Underlying contract handling the swaps
     * @param chainEvents               On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param events                    Instance to use for emitting events
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T, events?: EventEmitter) {
        super(storage, contract, chainEvents, swapDataDeserializer, events);
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
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    create(
        bolt11PayRequest: string,
        amountData: {
            token: TokenAddress
        },
        lps: Intermediary[],
        options: {
            expirySeconds: number,
            maxRoutingBaseFee: BN,
            maxRoutingPPM: BN
        },
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): {
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const parsedPR = bolt11.decode(bolt11PayRequest);

        if(parsedPR.millisatoshis==null) {
            throw new UserError("Must be an invoice with amount!");
        }

        const sats = new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000));

        const resultPromises = this.contract.payLightning(
            bolt11PayRequest,
            amountData,
            lps,
            {
                maxFee: this.calculateFeeForAmount(sats, options.maxRoutingBaseFee, options.maxRoutingPPM),
                expirySeconds: options.expirySeconds
            },
            null,
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                intermediary: data.intermediary,
                quote: data.response.then(response => new ToBTCLNSwap<T>(
                    this,
                    bolt11PayRequest,
                    response.data,
                    response.fees.networkFee,
                    response.fees.swapFee,
                    response.authorization.prefix,
                    response.authorization.timeout,
                    response.authorization.signature,
                    response.authorization.feeRate,
                    data.intermediary.url+"/tobtcln",
                    response.confidence,
                    response.routingFeeSats,
                    response.authorization.expiry,
                    response.pricingInfo
                ))
            }
        });

        //Swaps are saved when commit is called
        // await swap.save();
        // this.swapData[result.data.getHash()] = swap;

    }


    /**
     * Returns a newly created swap, paying for LNURL-pay
     *
     * @param lnurlPay              LNURL-pay link to use for payment
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    async createViaLNURL(
        lnurlPay: string | LNURLPay,
        amountData: AmountData,
        lps: Intermediary[],
        options: {
            expirySeconds: number,
            maxRoutingBaseFee: BN,
            maxRoutingPPM: BN,
            comment: string
        },
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): Promise<{
        quote: Promise<ToBTCLNSwap<T>>,
        intermediary: Intermediary
    }[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        let fee: Promise<BN>;
        let pricePreFetch: Promise<BN>;
        if(amountData.exactIn && options.maxRoutingBaseFee==null) {
            pricePreFetch = this.contract.swapPrice.preFetchPrice(amountData.token, abortSignal);
            fee = pricePreFetch.then(val => {
                return this.contract.swapPrice.getFromBtcSwapAmount(new BN(this.contract.options.lightningBaseFee), amountData.token, abortSignal, val)
            }).then(_maxBaseFee => {
                return this.calculateFeeForAmount(amountData.amount, _maxBaseFee, options.maxRoutingPPM);
            });
        } else {
            fee = Promise.resolve(this.calculateFeeForAmount(amountData.amount, options.maxRoutingBaseFee, options.maxRoutingPPM));
        }

        const resultPromises = await this.contract.payLightningLNURL(
            typeof(lnurlPay)==="string" ? lnurlPay : lnurlPay.params,
            amountData,
            lps,
            {
                expirySeconds: options.expirySeconds,
                comment: options.comment,
            },
            {
                maxFeePromise: fee,
                pricePreFetchPromise: pricePreFetch
            },
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                quote: data.response.then(response => new ToBTCLNSwap<T>(
                    this,
                    response.invoice,
                    response.data,
                    response.fees.networkFee,
                    response.fees.swapFee,
                    response.authorization.prefix,
                    response.authorization.timeout,
                    response.authorization.signature,
                    response.authorization.feeRate,
                    data.intermediary.url+"/tobtcln",
                    response.confidence,
                    response.routingFeeSats,
                    response.authorization.expiry,
                    response.pricingInfo,
                    typeof(lnurlPay)==="string" ? lnurlPay : lnurlPay.params.url,
                    response.successAction
                )),
                intermediary: data.intermediary
            }
        });

        //Swaps are saved when commit is called
        // await swap.save();
        // this.swapData[result.data.getHash()] = swap;

    }

}
