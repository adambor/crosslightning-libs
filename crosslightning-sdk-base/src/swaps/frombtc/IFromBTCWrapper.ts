import {IFromBTCSwap} from "./IFromBTCSwap";
import {SwapData, TokenAddress} from "crosslightning-base";
import {AmountData, ISwapWrapper, ISwapWrapperOptions} from "../ISwapWrapper";
import * as BN from "bn.js";
import randomBytes from "randombytes";
import {Intermediary} from "../../intermediaries/Intermediary";
import {IntermediaryError} from "../../errors/IntermediaryError";
import {tryWithRetries} from "../../utils/Utils";

export abstract class IFromBTCWrapper<
    T extends SwapData,
    S extends IFromBTCSwap<T, any>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> extends ISwapWrapper<T, S, O> {

    protected getRandomSequence(): BN {
        return new BN(randomBytes(8));
    }

    protected preFetchFeeRate(
        amountData: AmountData,
        hash: string | null,
        abortController: AbortController
    ): Promise<any | null> {
        return tryWithRetries(
            () => this.contract.getInitFeeRate(null, this.contract.getAddress(), amountData.token, hash),
            null, null, abortController.signal
        ).catch(e => {
            console.error(e);
            abortController.abort(e);
            return null;
        });
    }

    protected preFetchIntermediaryLiquidity(amountData: AmountData, lp: Intermediary, abortController: AbortController): Promise<BN | null> {
        return tryWithRetries(
            () => this.contract.getIntermediaryBalance(lp.address, amountData.token),
            null, null, abortController.signal
        ).catch(e => {
            abortController.abort(e);
            return null;
        })
    }

    protected async verifyIntermediaryLiquidity(
        lp: Intermediary,
        amount: BN,
        token: TokenAddress,
        liquidityPromise: Promise<BN>
    ): Promise<void> {
        const liquidity = await liquidityPromise;
        lp.liquidity[token.toString()] = liquidity;
        if(liquidity.lt(amount)) throw new IntermediaryError("Intermediary doesn't have enough liquidity");
    }

    protected isOurSwap(swap: S): boolean {
        return this.contract.areWeClaimer(swap.data);
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    public getClaimableSwaps(): Promise<S[]> {
        return Promise.resolve(this.getClaimableSwapsSync());
    }

    /**
     * Returns swaps that are claimable and that were initiated with the current provider's public key
     */
    public getClaimableSwapsSync(): S[] {
        return this.getAllSwapsSync().filter(swap => swap.isClaimable());
    }

}
