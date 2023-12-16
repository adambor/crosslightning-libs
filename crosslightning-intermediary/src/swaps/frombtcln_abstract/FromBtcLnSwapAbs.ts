import * as BN from "bn.js";
import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "../SwapHandlerSwap";
import {PluginManager} from "../../plugins/PluginManager";
import {FromBtcSwapState, SwapHandlerType} from "../..";

export enum FromBtcLnSwapState {
    REFUNDED = -2,
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3,
    SETTLED = 4,
}

export class FromBtcLnSwapAbs<T extends SwapData> extends SwapHandlerSwap<T> {

    state: FromBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    nonce: number;
    prefix: string;
    timeout: string;
    signature: string;
    feeRate: any;

    secret: string;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        if(typeof(prOrObj)==="string") {
            super();
            this.state = FromBtcLnSwapState.CREATED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            super(prOrObj);
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            this.secret = prOrObj.secret;
            this.nonce = prOrObj.nonce;
            this.prefix = prOrObj.prefix;
            this.timeout = prOrObj.timeout;
            this.signature = prOrObj.signature;
        }
        this.type = SwapHandlerType.FROM_BTCLN;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.state = this.state;
        partialSerialized.pr = this.pr;
        partialSerialized.swapFee = this.swapFee.toString(10);
        partialSerialized.secret = this.secret;
        partialSerialized.nonce = this.nonce;
        partialSerialized.feeRate = this.feeRate==null ? null : this.feeRate.toString();
        partialSerialized.prefix = this.prefix;
        partialSerialized.timeout = this.timeout;
        partialSerialized.signature = this.signature;
        return partialSerialized;
    }

    async setState(newState: FromBtcLnSwapState) {
        const oldState = this.state;
        this.state = newState;
        await PluginManager.swapStateChange(this, oldState);
    }

}
