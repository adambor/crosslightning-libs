import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "../SwapHandlerSwap";
import {PluginManager} from "../../plugins/PluginManager";
import {SwapHandlerType} from "../SwapHandler";

export enum FromBtcSwapState {
    REFUNDED = -2,
    CANCELED = -1,
    CREATED = 0,
    COMMITED = 1,
    CLAIMED = 2
}

export class FromBtcSwapAbs<T extends SwapData> extends SwapHandlerSwap<T> {

    state: FromBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    authorizationExpiry: BN;

    constructor(address: string, amount: BN, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN) {
        if(typeof(prOrObj)==="string") {
            super();
            this.state = FromBtcSwapState.CREATED;
            this.address = prOrObj;
            this.amount = amount;
            this.swapFee = swapFee;
        } else {
            super(prOrObj);
            this.state = prOrObj.state;
            this.address = prOrObj.address;
            this.amount = new BN(prOrObj.amount);
            this.swapFee = new BN(prOrObj.swapFee);
            this.authorizationExpiry = prOrObj.authorizationExpiry==null ? null : new BN(prOrObj.authorizationExpiry);
        }
        this.type = SwapHandlerType.FROM_BTC;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.state = this.state;
        partialSerialized.address = this.address;
        partialSerialized.amount = this.amount.toString(10);
        partialSerialized.swapFee = this.swapFee.toString(10);
        partialSerialized.authorizationExpiry = this.authorizationExpiry==null ? null : this.authorizationExpiry.toString(10);
        return partialSerialized;
    }

    getTxoHash(bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    async setState(newState: FromBtcSwapState) {
        const oldState = this.state;
        this.state = newState;
        await PluginManager.swapStateChange(this, oldState);
    }

}
