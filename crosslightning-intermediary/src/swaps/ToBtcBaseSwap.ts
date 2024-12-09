import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData} from "crosslightning-base";
import * as BN from "bn.js";
import {deserializeBN, serializeBN} from "../utils/Utils";


export abstract class ToBtcBaseSwap<T extends SwapData = SwapData, S = any> extends SwapHandlerSwap<T, S> {

    quotedNetworkFee: BN;
    readonly quotedNetworkFeeInToken: BN;
    realNetworkFee: BN;
    realNetworkFeeInToken: BN;

    protected constructor(chainIdentifier: string, swapFee: BN, swapFeeInToken: BN, quotedNetworkFee: BN, quotedNetworkFeeInToken: BN);
    protected constructor(obj: any);

    protected constructor(obj?: any | string, swapFee?: BN, swapFeeInToken?: BN, quotedNetworkFee?: BN, quotedNetworkFeeInToken?: BN) {
        if(typeof(obj)==="string" && BN.isBN(swapFee) && BN.isBN(swapFeeInToken) && BN.isBN(quotedNetworkFee) && BN.isBN(quotedNetworkFeeInToken)) {
            super(obj, swapFee, swapFeeInToken);
            this.quotedNetworkFee = quotedNetworkFee;
            this.quotedNetworkFeeInToken = quotedNetworkFeeInToken;
            return;
        } else {
            super(obj);
            this.quotedNetworkFee = deserializeBN(obj.quotedNetworkFee);
            this.quotedNetworkFeeInToken = deserializeBN(obj.quotedNetworkFeeInToken);
            this.realNetworkFee = deserializeBN(obj.realNetworkFee);
            this.realNetworkFeeInToken = deserializeBN(obj.realNetworkFeeInToken);
        }
    }

    serialize(): any {
        const obj = super.serialize();
        obj.quotedNetworkFee = serializeBN(this.quotedNetworkFee);
        obj.quotedNetworkFeeInToken = serializeBN(this.quotedNetworkFeeInToken);
        obj.realNetworkFee = serializeBN(this.realNetworkFee);
        obj.realNetworkFeeInToken = serializeBN(this.realNetworkFeeInToken);
        return obj;
    }

    setRealNetworkFee(networkFeeInBtc: BN) {
        this.realNetworkFee = networkFeeInBtc;
        if(this.quotedNetworkFee!=null && this.quotedNetworkFeeInToken!=null) {
            this.realNetworkFeeInToken = this.realNetworkFee.mul(this.quotedNetworkFeeInToken).div(this.quotedNetworkFee);
        }
    }

    getInputAmount(): BN {
        return this.data.getAmount().sub(this.getSwapFee().inInputToken).sub(this.getQuotedNetworkFee().inInputToken);
    }

    getTotalInputAmount(): BN {
        return this.data.getAmount();
    }

    getSwapFee(): { inInputToken: BN; inOutputToken: BN } {
        return {inInputToken: this.swapFeeInToken, inOutputToken: this.swapFee};
    }

    /**
     * Returns quoted (expected) network fee, denominated in input & output tokens (the fee is paid only once, it is
     *  just represented here in both denomination for ease of use)
     */
    getQuotedNetworkFee(): { inInputToken: BN; inOutputToken: BN } {
        return {inInputToken: this.quotedNetworkFeeInToken, inOutputToken: this.quotedNetworkFee};
    }

    /**
     * Returns real network fee paid for the swap, denominated in input & output tokens (the fee is paid only once, it is
     *  just represented here in both denomination for ease of use)
     */
    getRealNetworkFee(): { inInputToken: BN; inOutputToken: BN } {
        return {inInputToken: this.realNetworkFeeInToken, inOutputToken: this.realNetworkFee};
    }

}