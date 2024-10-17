import {SwapData} from "crosslightning-base";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import * as BN from "bn.js";

export abstract class FromBtcBaseSwap<T extends SwapData, S = any> extends SwapHandlerSwap<T, S> {

    getInputAmount(): BN {
        return this.getTotalInputAmount().sub(this.getSwapFee().inInputToken);
    }

    abstract getTotalInputAmount(): BN;

    getOutputAmount(): BN {
        return this.data.getAmount();
    }

    getSwapFee(): { inInputToken: BN; inOutputToken: BN } {
        return {inInputToken: this.swapFee, inOutputToken: this.swapFeeInToken};
    }

}