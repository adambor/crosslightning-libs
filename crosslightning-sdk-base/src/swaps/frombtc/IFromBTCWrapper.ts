import {IFromBTCSwap} from "./IFromBTCSwap";
import {SwapData} from "crosslightning-base";
import {ISwapWrapper} from "../ISwapWrapper";

export abstract class IFromBTCWrapper<T extends SwapData, S extends IFromBTCSwap<T>> extends ISwapWrapper<T, S> {

    protected isOurSwap(swap: S): boolean {
        return this.contract.swapContract.areWeClaimer(swap.data);
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    public getClaimableSwaps(): Promise<S[]> {
        return Promise.resolve(this.getClaimableSwapsSync());
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    public getClaimableSwapsSync(): S[] {
        return this.getAllSwapsSync().filter(swap => swap.isClaimable());
    }

}
