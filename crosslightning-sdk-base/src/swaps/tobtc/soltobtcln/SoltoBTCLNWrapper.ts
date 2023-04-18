import * as bolt11 from "bolt11";
import {SoltoBTCLNSwap} from "./SoltoBTCLNSwap";
import {ISolToBTCxWrapper} from "../ISolToBTCxWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {ClientSwapContract} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {UserError} from "../../../errors/UserError";
import {ChainEvents, SwapData, TokenAddress} from "crosslightning-base";

export class SoltoBTCLNWrapper<T extends SwapData> extends ISolToBTCxWrapper<T> {

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>) {
        super(storage, contract, chainEvents);
    }

    private calculateFeeForAmount(amount: BN) : BN {
        return new BN(this.contract.options.lightningBaseFee).add(amount.mul(new BN(this.contract.options.lightningFeePPM)).div(new BN(1000000)));
    }

    init(): Promise<void> {
        return super.initWithConstructor(SoltoBTCLNSwap);
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param bolt11PayRequest  BOLT11 payment request (bitcoin lightning invoice) you wish to pay
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     * @param requiredToken     Token that we want to send
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     */
    async create(bolt11PayRequest: string, expirySeconds: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<SoltoBTCLNSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const parsedPR = bolt11.decode(bolt11PayRequest);

        if(parsedPR.satoshis==null) {
            throw new UserError("Must be an invoice with amount!");
        }

        const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));

        const fee = this.calculateFeeForAmount(sats);

        const result = await this.contract.payLightning(bolt11PayRequest, expirySeconds, fee, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM);

        const swap = new SoltoBTCLNSwap(
            this,
            bolt11PayRequest,
            result.data,
            result.swapFee.add(result.maxFee),
            result.prefix,
            result.timeout,
            result.signature,
            result.nonce,
            url,
            result.confidence,
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

}
