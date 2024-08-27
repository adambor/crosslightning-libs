import {ToBTCSwap} from "./ToBTCSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {AmountData, ClientSwapContract} from "../../ClientSwapContract";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";
import {EventEmitter} from "events";
import { Intermediary } from "../../../intermediaries/Intermediary";

export type ToBTCOptions = {
    confirmationTarget: number,
    confirmations: number
}

export class ToBTCWrapper<T extends SwapData> extends IToBTCWrapper<T> {

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

    /**
     * Returns quotes fetched from LPs, paying to an 'address' - a bitcoin address
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    create(
        address: string,
        amountData: AmountData,
        lps: Intermediary[],
        options: ToBTCOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): {
        quote: Promise<ToBTCSwap<T>>,
        intermediary: Intermediary
    }[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const resultPromises = this.contract.payOnchain(
            address,
            amountData,
            lps,
            options,
            additionalParams,
            abortSignal
        );

        return resultPromises.map(data => {
            return {
                quote: data.response.then(response => new ToBTCSwap<T>(
                    this,
                    address,
                    response.amount,
                    options.confirmationTarget,
                    response.fees.networkFee,
                    response.fees.swapFee,
                    response.fees.totalFee,
                    response.data,
                    response.authorization.prefix,
                    response.authorization.timeout,
                    response.authorization.signature,
                    response.authorization.feeRate,
                    data.intermediary.url+"/tobtc",
                    response.authorization.expiry,
                    response.pricingInfo
                )),
                intermediary: data.intermediary
            };
        });

        //Swaps are saved when commit is called
        // await swap.save();
        // this.swapData[result.data.getHash()] = swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    async init() {
        return super.initWithConstructor(ToBTCSwap);
    }

}
