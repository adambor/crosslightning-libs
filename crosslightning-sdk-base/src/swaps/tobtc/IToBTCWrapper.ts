import {IToBTCSwap, ToBTCSwapState} from "./IToBTCSwap";
import {ChainType, ClaimEvent, InitializeEvent, RefundEvent, SwapCommitStatus} from "crosslightning-base";
import {AmountData, ISwapWrapper, ISwapWrapperOptions} from "../ISwapWrapper";
import {tryWithRetries} from "../../utils/Utils";
import {Intermediary, SingleChainReputationType} from "../../intermediaries/Intermediary";
import {IntermediaryError} from "../../errors/IntermediaryError";


export abstract class IToBTCWrapper<
    T extends ChainType,
    S extends IToBTCSwap<T> = IToBTCSwap<T>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> extends ISwapWrapper<T, S, O> {

    /**
     * Checks the swap's state on-chain and compares it to its internal state, updates/changes it according to on-chain
     *  data
     *
     * @param swap Swap to be checked
     * @private
     */
    private async syncStateFromChain(swap: S): Promise<boolean> {
        if(
            swap.state===ToBTCSwapState.CREATED ||
            swap.state===ToBTCSwapState.QUOTE_SOFT_EXPIRED ||
            swap.state===ToBTCSwapState.COMMITED ||
            swap.state===ToBTCSwapState.SOFT_CLAIMED ||
            swap.state===ToBTCSwapState.REFUNDABLE
        ) {
            const res = await tryWithRetries(() => this.contract.getCommitStatus(swap.getInitiator(), swap.data));
            switch(res) {
                case SwapCommitStatus.PAID:
                    swap.state = ToBTCSwapState.CLAIMED;
                    return true;
                case SwapCommitStatus.REFUNDABLE:
                    swap.state = ToBTCSwapState.REFUNDABLE;
                    return true;
                case SwapCommitStatus.EXPIRED:
                    swap.state = ToBTCSwapState.QUOTE_EXPIRED;
                    return true;
                case SwapCommitStatus.NOT_COMMITED:
                    if(swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.REFUNDABLE) {
                        swap.state = ToBTCSwapState.REFUNDED;
                        return true;
                    }
                    break;
                case SwapCommitStatus.COMMITED:
                    if(swap.state!==ToBTCSwapState.COMMITED && swap.state!==ToBTCSwapState.REFUNDABLE) {
                        swap.state = ToBTCSwapState.COMMITED;
                        return true;
                    }
                    break;
            }
        }
    }

    /**
     * Pre-fetches intermediary's reputation, doesn't throw, instead aborts via abortController and returns null
     *
     * @param amountData
     * @param lp Intermediary
     * @param abortController
     * @protected
     * @returns Intermediary's reputation or null if failed
     * @throws {IntermediaryError} If the intermediary vault doesn't exist
     */
    protected preFetchIntermediaryReputation(
        amountData: Omit<AmountData, "amount">,
        lp: Intermediary,
        abortController: AbortController
    ): Promise<SingleChainReputationType | null> {
        return lp.getReputation(this.chainIdentifier, this.contract, [amountData.token.toString()], abortController.signal).then(res => {
            if(res==null) throw new IntermediaryError("Invalid data returned - invalid LP vault");
            return res;
        }).catch(e => {
            this.logger.error("preFetchIntermediaryReputation(): Error: ", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Pre-fetches feeRate for a given swap
     *
     * @param signer Address of the swap initiator
     * @param amountData
     * @param hash optional hash of the swap or null
     * @param abortController
     * @protected
     * @returns Fee rate
     */
    protected preFetchFeeRate(signer: string, amountData: Omit<AmountData, "amount">, hash: string | null, abortController: AbortController): Promise<any | null> {
        return tryWithRetries(
            () => this.contract.getInitPayInFeeRate(signer, null, amountData.token, hash),
            null, null, abortController.signal
        ).catch(e => {
            this.logger.error("preFetchFeeRate(): Error: ", e);
            abortController.abort(e);
            return null;
        });
    }

    protected async checkPastSwap(swap: S): Promise<boolean> {
        let changed = await this.syncStateFromChain(swap);

        if((swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.QUOTE_SOFT_EXPIRED) && !await swap.isQuoteValid()) {
            //Check if quote is still valid
            swap.state = ToBTCSwapState.QUOTE_EXPIRED;
            changed ||= true;
        }

        if(swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.SOFT_CLAIMED) {
            //Check if that maybe already concluded
            changed ||= await swap.checkIntermediarySwapProcessed(false);
        }

        return changed;
    }

    protected tickSwap(swap: S): void {
        switch(swap.state) {
            case ToBTCSwapState.CREATED:
                if(swap.expiry<Date.now()) swap._saveAndEmit(ToBTCSwapState.QUOTE_SOFT_EXPIRED);
                break;
            case ToBTCSwapState.COMMITED:
            case ToBTCSwapState.SOFT_CLAIMED:
                if(this.contract.isExpired(swap.getInitiator(), swap.data)) swap._saveAndEmit(ToBTCSwapState.REFUNDABLE);
                break;
        }
    }

    protected async processEventInitialize(swap: S, event: InitializeEvent<T["Data"]>): Promise<boolean> {
        if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.QUOTE_SOFT_EXPIRED) {
            const swapData = await event.swapData();
            if(swap.data!=null && !swap.data.equals(swapData)) return false;
            if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.QUOTE_SOFT_EXPIRED) swap.state = ToBTCSwapState.COMMITED;
            swap.data = swapData;
            return true;
        }
    }

    protected processEventClaim(swap: S, event: ClaimEvent<T["Data"]>): Promise<boolean> {
        if(swap.state!==ToBTCSwapState.REFUNDED) {
            swap.state = ToBTCSwapState.CLAIMED;
            swap._setPaymentResult({secret: event.secret, txId: event.secret});
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected processEventRefund(swap: S, event: RefundEvent<T["Data"]>): Promise<boolean> {
        if(swap.state!==ToBTCSwapState.CLAIMED) {
            swap.state = ToBTCSwapState.REFUNDED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected isOurSwap(signer: string, swap: S): boolean {
        return swap.data.isOfferer(signer);
    }

    /**
     * Returns all swaps that are refundable, and optionally only those initiated with signer's address
     */
    public getRefundableSwaps(signer?: string): Promise<S[]> {
        return Promise.resolve(this.getRefundableSwapsSync(signer));
    }

    /**
     * Returns all swaps that are refundable, and optionally only those initiated with signer's address
     */
    public getRefundableSwapsSync(signer?: string): S[] {
        return this.getAllSwapsSync(signer).filter(swap => swap.isRefundable());
    }

}
