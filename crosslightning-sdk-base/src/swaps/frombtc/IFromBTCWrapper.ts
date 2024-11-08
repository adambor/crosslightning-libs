import {IFromBTCSwap} from "./IFromBTCSwap";
import {AmountData, ISwapWrapper, ISwapWrapperOptions} from "../ISwapWrapper";
import * as BN from "bn.js";
import * as randomBytes from "randombytes";
import {Intermediary} from "../../intermediaries/Intermediary";
import {IntermediaryError} from "../../errors/IntermediaryError";
import {tryWithRetries} from "../../utils/Utils";
import {ChainType} from "crosslightning-base";

export abstract class IFromBTCWrapper<
    T extends ChainType,
    S extends IFromBTCSwap<T, any>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> extends ISwapWrapper<T, S, O> {

    /**
     * Returns a random sequence to be used for swaps
     *
     * @protected
     * @returns Random 64-bit sequence number
     */
    protected getRandomSequence(): BN {
        return new BN(randomBytes(8));
    }

    /**
     * Pre-fetches feeRate for a given swap
     *
     * @param signer Address initiating the swap
     * @param amountData
     * @param hash optional hash of the swap or null
     * @param abortController
     * @protected
     * @returns Fee rate
     */
    protected preFetchFeeRate(
        signer: string,
        amountData: AmountData,
        hash: string | null,
        abortController: AbortController
    ): Promise<any | null> {
        return tryWithRetries(
            () => this.contract.getInitFeeRate(null, signer, amountData.token, hash),
            null, null, abortController.signal
        ).catch(e => {
            this.logger.error("preFetchFeeRate(): Error: ", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Pre-fetches intermediary's available SC on-chain liquidity
     * @param amountData
     * @param lp Intermediary
     * @param abortController
     * @protected
     * @returns Intermediary's liquidity balance
     */
    protected preFetchIntermediaryLiquidity(amountData: AmountData, lp: Intermediary, abortController: AbortController): Promise<BN | null> {
        return lp.getLiquidity(this.chainIdentifier, this.contract, amountData.token.toString(), abortController.signal).catch(e => {
            this.logger.error("preFetchIntermediaryLiquidity(): Error: ", e);
            abortController.abort(e);
            return null;
        })
    }

    /**
     * Verifies whether the intermediary has enough available liquidity such that we can initiate the swap
     *
     * @param amount Swap amount that we should receive
     * @param liquidityPromise pre-fetched liquidity promise as obtained from preFetchIntermediaryLiquidity()
     * @protected
     * @throws {IntermediaryError} if intermediary's liquidity is lower than what's required for the swap
     */
    protected async verifyIntermediaryLiquidity(
        amount: BN,
        liquidityPromise: Promise<BN>
    ): Promise<void> {
        const liquidity = await liquidityPromise;
        if(liquidity.lt(amount)) throw new IntermediaryError("Intermediary doesn't have enough liquidity");
    }

    protected isOurSwap(signer: string, swap: S): boolean {
        return swap.data.isClaimer(signer);
    }

    /**
     * Returns all swaps that are claimable, and optionally only those initiated with signer's address
     */
    public getClaimableSwaps(signer?: string): Promise<S[]> {
        return Promise.resolve(this.getClaimableSwapsSync(signer));
    }

    /**
     * Returns all swaps that are claimable, and optionally only those initiated with signer's address
     */
    public getClaimableSwapsSync(signer?: string): S[] {
        return this.getAllSwapsSync(signer).filter(swap => swap.isClaimable());
    }

}
