import {ToBTCSwap} from "./ToBTCSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {ClientSwapContract} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";
import * as EventEmitter from "events";

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
     * Returns a newly created swap, paying for 'address' - a bitcoin address
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param amount                Amount of bitcoin to send, in base units - satoshis
     * @param confirmationTarget    Time preference of the transaction (in how many blocks should it confirm)
     * @param confirmations         Confirmations required for intermediary to claim the funds from PTLC (this determines the safety of swap)
     * @param url                   Intermediary/Counterparty swap service url
     * @param requiredToken         Token that we want to send
     * @param requiredKey           Required key of the Intermediary
     * @param requiredBaseFee       Desired base fee reported by the swap intermediary
     * @param requiredFeePPM        Desired proportional fee report by the swap intermediary
     * @param exactIn               Whether the swap should be exact in instead of exact out
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     */
    async create(
        address: string,
        amount: BN,
        confirmationTarget: number,
        confirmations: number,
        url: string,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<ToBTCSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.payOnchain(address, amount, confirmationTarget, confirmations, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM, exactIn, additionalParams);

        const swap = new ToBTCSwap(
            this,
            address,
            result.amount,
            confirmationTarget,
            result.networkFee,
            result.swapFee,
            result.totalFee,
            result.data,
            result.prefix,
            result.timeout,
            result.signature,
            result.feeRate,
            url,
            result.expiry,
            result.pricingInfo
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    async init() {
        return super.initWithConstructor(ToBTCSwap);
    }

}
