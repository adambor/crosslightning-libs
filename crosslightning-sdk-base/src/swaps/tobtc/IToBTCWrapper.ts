import {IToBTCSwap, ToBTCSwapState} from "./IToBTCSwap";
import {
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapCommitStatus,
    SwapData
} from "crosslightning-base";
import {tryWithRetries} from "../../utils/RetryUtils";
import {ISwapWrapper, ISwapWrapperOptions} from "../ISwapWrapper";
import {AmountData} from "../ClientSwapContract";


export abstract class IToBTCWrapper<
    T extends SwapData,
    S extends IToBTCSwap<T> = IToBTCSwap<T>,
    O extends ISwapWrapperOptions = ISwapWrapperOptions
> extends ISwapWrapper<T, S, O> {

    private async syncStateFromChain(swap: S): Promise<boolean> {
        if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.COMMITED) {
            const res = await tryWithRetries(() => this.contract.getCommitStatus(swap.data));
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
                    if(swap.state===ToBTCSwapState.COMMITED) {
                        swap.state = ToBTCSwapState.REFUNDED;
                        return true;
                    }
                    break;
                case SwapCommitStatus.COMMITED:
                    if(swap.state!==ToBTCSwapState.COMMITED) {
                        swap.state = ToBTCSwapState.COMMITED;
                        return true;
                    }
                    break;
            }
        }
    }

    protected preFetchFeeRate(amountData: Omit<AmountData, "amount">, hash: string | null, abortController: AbortController): Promise<any | null> {
        return tryWithRetries(
            () => this.contract.getInitPayInFeeRate(this.contract.getAddress(), null, amountData.token, hash),
            null, null, abortController.signal
        ).catch(e => {
            console.error(e);
            abortController.abort(e);
            return null;
        });
    }

    protected async checkPastSwap(swap: S): Promise<boolean> {
        let changed = await this.syncStateFromChain(swap);

        if(swap.state===ToBTCSwapState.CREATED && !await swap.isQuoteValid()) {
            //Check if quote is still valid
            swap.state = ToBTCSwapState.QUOTE_EXPIRED;
            changed ||= true;
        }

        if(swap.state===ToBTCSwapState.COMMITED) {
            //Check if that maybe already concluded
            changed ||= await swap.checkIntermediarySwapProcessed(false);
        }

        return changed;
    }

    protected async processEventInitialize(swap: S, event: InitializeEvent<T>): Promise<boolean> {
        if(swap.state==ToBTCSwapState.CREATED) {
            const swapData = await event.swapData();
            if(swap.data!=null && !swap.data.equals(swapData)) return false;
            if(swap.state===ToBTCSwapState.CREATED) swap.state = ToBTCSwapState.COMMITED;
            swap.data = swapData;
            return true;
        }
    }

    protected processEventClaim(swap: S, event: ClaimEvent<T>): Promise<boolean> {
        if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.REFUNDABLE) {
            swap.state = ToBTCSwapState.CLAIMED;
            swap._setPaymentResult({secret: event.secret, txId: event.secret});
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected processEventRefund(swap: S, event: RefundEvent<T>): Promise<boolean> {
        if(swap.state===ToBTCSwapState.CREATED || swap.state===ToBTCSwapState.COMMITED || swap.state===ToBTCSwapState.REFUNDABLE) {
            swap.state = ToBTCSwapState.REFUNDED;
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    protected isOurSwap(swap: S): boolean {
        return this.contract.areWeOfferer(swap.data);
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    public getRefundableSwaps(): Promise<S[]> {
        return Promise.resolve(this.getRefundableSwapsSync());
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    public getRefundableSwapsSync(): S[] {
        return this.getAllSwapsSync().filter(swap => swap.isRefundable());
    }

}
