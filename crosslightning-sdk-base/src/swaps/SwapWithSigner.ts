import {ISwap} from "./ISwap";
import {ChainType} from "crosslightning-base";
import {IToBTCSwap} from "./tobtc/IToBTCSwap";
import {IFromBTCSwap} from "./frombtc/IFromBTCSwap";
import {FromBTCLNSwap} from "./frombtc/ln/FromBTCLNSwap";

export type SwapWithSigner<T extends ISwap> = {
    [K in keyof T]:
        K extends "commit" ? (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean) => Promise<string> :
        K extends "refund" ? (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal) => Promise<string> :
        K extends "claim" ? (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal) => Promise<string> :
        K extends "commitAndClaim" ? (abortSignal?: AbortSignal, skipChecks?: boolean) => Promise<string> :
            T[K];
};

export function wrapSwapWithSigner<C extends ChainType, T extends ISwap<C>>(swap: T, signer: C["Signer"]): SwapWithSigner<T> {
    return new Proxy(swap, {
        get: (target, prop, receiver) => {
            // Override the "sayGoodbye" method
            if (prop === "commit") {
                if(swap instanceof IToBTCSwap || swap instanceof IFromBTCSwap) {
                    return (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean) =>
                        swap.commit(signer, noWaitForConfirmation, abortSignal, skipChecks);
                }
            }
            if (prop === "refund") {
                if(swap instanceof IToBTCSwap) {
                    return (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal) =>
                        swap.refund(signer, noWaitForConfirmation, abortSignal);
                }
            }
            if (prop === "claim") {
                if(swap instanceof IFromBTCSwap) {
                    return (noWaitForConfirmation?: boolean, abortSignal?: AbortSignal) =>
                        swap.claim(signer, noWaitForConfirmation, abortSignal);
                }
            }
            if (prop === "commitAndClaim") {
                if(swap instanceof FromBTCLNSwap) {
                    return (abortSignal?: AbortSignal, skipChecks?: boolean) =>
                        swap.commitAndClaim(signer, abortSignal, skipChecks);
                }
            }

            // Delegate other properties and methods to the original instance
            return Reflect.get(target, prop, receiver);
        }
    }) as SwapWithSigner<T>;
}
