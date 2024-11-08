import {ToBTCWrapper} from "./ToBTCWrapper";
import {isIToBTCSwapInit, IToBTCSwap, IToBTCSwapInit} from "../IToBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {ChainType, SwapData} from "crosslightning-base";
import {Buffer} from "buffer";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {BtcToken} from "../../ISwap";


export type ToBTCSwapInit<T extends SwapData> = IToBTCSwapInit<T> & {
    address: string;
    amount: BN;
    confirmationTarget: number;
    satsPerVByte: number;
};

export function isToBTCSwapInit<T extends SwapData>(obj: any): obj is ToBTCSwapInit<T> {
    return typeof(obj.address)==="string" &&
        BN.isBN(obj.amount) &&
        typeof(obj.confirmationTarget)==="number" &&
        typeof(obj.satsPerVByte)==="number" &&
        isIToBTCSwapInit<T>(obj);
}

export class ToBTCSwap<T extends ChainType> extends IToBTCSwap<T> {
    protected readonly TYPE = SwapType.TO_BTC;

    protected readonly wrapper: ToBTCWrapper<T>;

    private readonly address: string;
    private readonly amount: BN;
    private readonly confirmationTarget: number;
    private readonly satsPerVByte: number;

    private txId?: string;

    constructor(wrapper: ToBTCWrapper<T>, serializedObject: any);
    constructor(wrapper: ToBTCWrapper<T>, init: ToBTCSwapInit<T["Data"]>);
    constructor(
        wrapper: ToBTCWrapper<T>,
        initOrObject: ToBTCSwapInit<T["Data"]> | any
    ) {
        if(isToBTCSwapInit(initOrObject)) initOrObject.url += "/tobtc";
        super(wrapper, initOrObject);
        if(!isToBTCSwapInit(initOrObject)) {
            this.address = initOrObject.address;
            this.amount = new BN(initOrObject.amount);
            this.confirmationTarget = initOrObject.confirmationTarget;
            this.satsPerVByte = initOrObject.satsPerVByte;
            this.txId = initOrObject.txId;
        }
        this.tryCalculateSwapFee();
    }

    async _setPaymentResult(result: { secret?: string; txId?: string }, check: boolean = false): Promise<boolean> {
        if(result==null) return false;
        if(result.txId==null) throw new IntermediaryError("No btc txId returned!");
        if(check) {
            const btcTx = await this.wrapper.btcRpc.getTransaction(result.txId);
            if(btcTx==null) return false;

            const foundVout = btcTx.outs.find(vout => this.data.getHash()===this.wrapper.contract.getHashForOnchain(
                Buffer.from(vout.scriptPubKey.hex, "hex"),
                new BN(vout.value),
                this.data.getEscrowNonce()
            ).toString("hex"));

            if(foundVout==null) throw new IntermediaryError("Invalid btc txId returned");
        }
        this.txId = result.txId;
        return true;
    }


    //////////////////////////////
    //// Amounts & fees

    getOutAmount(): BN {
        return this.amount
    }

    getOutToken(): BtcToken<false> {
        return {
            chain: "BTC",
            lightning: false
        };
    }


    //////////////////////////////
    //// Getters & utils

    /**
     * Returns fee rate of the bitcoin transaction in sats/vB
     */
    getBitcoinFeeRate(): number {
        return this.satsPerVByte;
    }

    /**
     * Returns the bitcoin address where the BTC will be sent to
     */
    getBitcoinAddress(): string {
        return this.address;
    }

    /**
     * Returns the transaction ID of the transaction sending the BTC
     */
    getBitcoinTxId(): string | null {
        return this.txId;
    }


    //////////////////////////////
    //// Storage

    serialize(): any {
        return {
            ...super.serialize(),
            address: this.address,
            amount: this.amount.toString(10),
            confirmationTarget: this.confirmationTarget,
            satsPerVByte: this.satsPerVByte,
            txId: this.txId
        };
    }

}
