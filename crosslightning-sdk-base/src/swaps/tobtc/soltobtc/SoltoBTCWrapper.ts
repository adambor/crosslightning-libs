import {SoltoBTCSwap} from "./SoltoBTCSwap";
import {ISolToBTCxWrapper} from "../ISolToBTCxWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {ClientSwapContract} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";

export class SoltoBTCWrapper<T extends SwapData> extends ISolToBTCxWrapper<T> {


    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T) {
        super(storage, contract, chainEvents, swapDataDeserializer);
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
     */
    async create(address: string, amount: BN, confirmationTarget: number, confirmations: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<SoltoBTCSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.payOnchain(address, amount, confirmationTarget, confirmations, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM);

        const swap = new SoltoBTCSwap(
            this,
            address,
            amount,
            confirmationTarget,
            result.networkFee,
            result.swapFee,
            result.totalFee,
            result.data,
            result.prefix,
            result.timeout,
            result.signature,
            result.nonce,
            url,
            result.expiry
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

    /**
     * Returns a newly created swap, paying for 'address' - a bitcoin address, with exactly specified swap input instead of output
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param tokenAmount                Amount of token to send, in base units
     * @param confirmationTarget    Time preference of the transaction (in how many blocks should it confirm)
     * @param confirmations         Confirmations required for intermediary to claim the funds from PTLC (this determines the safety of swap)
     * @param url                   Intermediary/Counterparty swap service url
     * @param requiredToken         Token that we want to send
     * @param requiredKey           Required key of the Intermediary
     * @param requiredBaseFee       Desired base fee reported by the swap intermediary
     * @param requiredFeePPM        Desired proportional fee report by the swap intermediary
     */
    async createExactIn(address: string, tokenAmount: BN, confirmationTarget: number, confirmations: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<SoltoBTCSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.payOnchainExactIn(address, tokenAmount, confirmationTarget, confirmations, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM);

        const swap = new SoltoBTCSwap(
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
            result.nonce,
            url,
            result.expiry
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
        return super.initWithConstructor(SoltoBTCSwap);
    }

}
