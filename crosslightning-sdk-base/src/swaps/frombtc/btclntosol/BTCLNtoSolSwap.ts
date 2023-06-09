import * as bolt11 from "bolt11";
import {BTCLNtoSolWrapper} from "./BTCLNtoSolWrapper";
import {IBTCxtoSolSwap, BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";

export class BTCLNtoSolSwap<T extends SwapData> extends IBTCxtoSolSwap<T> {

    state: BTCxtoSolSwapState;

    //State: PR_CREATED
    readonly pr: string;
    readonly secret: Buffer;
    readonly requiredBaseFee: BN;
    readonly requiredFeePPM: BN;
    readonly expectedOut: BN;
    readonly lnurl: string;
    readonly callbackPromise: Promise<void>;

    constructor(wrapper: BTCLNtoSolWrapper<T>, pr: string, secret: Buffer, url: string, data: T, swapFee: BN, requiredBaseFee: BN, requiredFeePPM: BN, expectedOut: BN, lnurl: string, callbackPromise: Promise<void>);
    constructor(wrapper: BTCLNtoSolWrapper<T>, obj: any);

    constructor(wrapper: BTCLNtoSolWrapper<T>, prOrObject: string | any, secret?: Buffer, url?: string, data?: T, swapFee?: BN, requiredBaseFee?: BN, requiredFeePPM?: BN, expectedOut?: BN, lnurl?: string, callbackPromise?: Promise<void>) {
        if(typeof(prOrObject)==="string") {
            super(wrapper, url, data, swapFee, null, null, null, null, null);
            this.state = BTCxtoSolSwapState.PR_CREATED;

            this.pr = prOrObject;
            this.secret = secret;
            this.requiredBaseFee = requiredBaseFee;
            this.requiredFeePPM = requiredFeePPM;
            this.expectedOut = expectedOut;
            this.lnurl = lnurl;
            this.callbackPromise = callbackPromise;
        } else {
            super(wrapper, prOrObject);
            this.state = prOrObject.state;

            this.pr = prOrObject.pr;
            this.secret = Buffer.from(prOrObject.secret, "hex");
            this.requiredBaseFee = prOrObject.requiredBaseFee==null ? null : new BN(prOrObject.requiredBaseFee);
            this.requiredFeePPM = prOrObject.requiredFeePPM==null ? null : new BN(prOrObject.requiredFeePPM);
            this.expectedOut = prOrObject.expectedOut==null ? null : new BN(prOrObject.expectedOut);
            this.lnurl = prOrObject.lnurl;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN {
        if(this.data!=null && this.data.getAmount()!=null) return this.data.getAmount();
        return this.expectedOut;
    }

    /**
     * Returns amount that will be sent on Bitcoin LN
     */
    getInAmount(): BN {
        const parsed = bolt11.decode(this.pr);
        return new BN(parsed.satoshis);
    }

    serialize(): any{
        const partiallySerialized = super.serialize();

        partiallySerialized.state = this.state;
        partiallySerialized.pr = this.pr;
        partiallySerialized.secret = this.secret;
        partiallySerialized.requiredBaseFee = this.requiredBaseFee==null ? null : this.requiredBaseFee.toString(10);
        partiallySerialized.requiredFeePPM = this.requiredFeePPM==null ? null : this.requiredFeePPM.toString(10);
        partiallySerialized.expectedOut = this.expectedOut==null ? null : this.expectedOut.toString(10);
        partiallySerialized.lnurl = this.lnurl;

        return partiallySerialized;
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<void> {
        if(this.state!==BTCxtoSolSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const abortController = new AbortController();

        if(abortSignal!=null) abortSignal.onabort = () => abortController.abort();

        console.log("Waiting for payment....");

        let callbackError = null;

        if(this.callbackPromise!=null) this.callbackPromise.catch(e => {
            callbackError = e;
            abortController.abort();
        });

        let result;
        try {
            result = await this.wrapper.contract.waitForIncomingPaymentAuthorization(this.pr, this.url, this.data.getToken(), this.data.getOfferer(), this.requiredBaseFee, this.requiredFeePPM, this.data.getSecurityDeposit(), abortController.signal, checkIntervalSeconds);
        } catch (e) {
            if(callbackError!=null) throw callbackError;
            throw e;
        }

        if(abortController.signal.aborted) {
            if(callbackError!=null) throw callbackError;
            throw new Error("Aborted");
        }

        this.state = BTCxtoSolSwapState.PR_PAID;

        this.data = result.data;
        this.prefix = result.prefix;
        this.timeout = result.timeout;
        this.signature = result.signature;
        this.nonce = result.nonce;
        this.expiry = result.expiry;

        await this.save();

        this.emitEvent();
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        return this.state===BTCxtoSolSwapState.PR_PAID;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCxtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        const txResult = await this.wrapper.contract.swapContract.init(this.data, this.timeout, this.prefix, this.signature, this.nonce, null, !noWaitForConfirmation, abortSignal);

        this.commitTxId = txResult;
        await this.save();

        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        // this.state = BTCxtoSolSwapState.CLAIM_COMMITED;
        //
        // await this.save();
        //
        // this.emitEvent();

        return txResult;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     */
    async txsCommit(): Promise<any[]> {
        if(this.state!==BTCxtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        return await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, this.nonce, null);
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
                this.events.removeListener("swapState", listener);
                reject("Aborted");
            };
        });
    }

    /**
     * Returns if the swap can be claimed
     */
    canClaim(): boolean {
        return this.state===BTCxtoSolSwapState.CLAIM_COMMITED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCxtoSolSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }

        const txResult = await this.wrapper.contract.swapContract.claimWithSecret(this.data, this.secret.toString("hex"), true, true, !noWaitForConfirmation, abortSignal);

        this.claimTxId = txResult;
        await this.save();

        if(!noWaitForConfirmation) {
            await this.waitTillClaimed(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        // this.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
        //
        // await this.save();
        //
        // this.emitEvent();

        return txResult;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     */
    async txsClaim(): Promise<any[]> {
        if(this.state!==BTCxtoSolSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }

        return await this.wrapper.contract.swapContract.txsClaimWithSecret(this.data, this.secret.toString("hex"), true, true);
    }

    /**
     * Returns a promise that resolves when swap is claimed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===BTCxtoSolSwapState.CLAIM_CLAIMED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCxtoSolSwapState.CLAIM_CLAIMED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
                this.events.removeListener("swapState", listener);
                reject("Aborted");
            };
        });
    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     *
     * @param abortSignal       Abort signal
     */
    async commitAndClaim(abortSignal?: AbortSignal): Promise<string[]> {

        if(this.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
            return [
                null,
                await this.claim(false, abortSignal)
            ];
        }

        if(this.state!==BTCxtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.pr, this.url, this.data.getToken(), this.data.getOfferer(), this.requiredBaseFee, this.requiredFeePPM);
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }

        const txResult = await this.wrapper.contract.swapContract.initAndClaimWithSecret(
            this.data,
            this.timeout,
            this.prefix,
            this.signature,
            this.nonce,
            this.secret.toString("hex"),
            true,
            abortSignal
        );

        this.commitTxId = txResult[0] || this.commitTxId;
        this.claimTxId = txResult[1] || this.claimTxId;
        await this.save();

        await this.waitTillClaimed(abortSignal);

        console.log("Claim tx confirmed!");

        return txResult;

    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     */
    async txsCommitAndClaim(): Promise<any[]> {

        if(this.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
            return await this.txsClaim();
        }

        if(this.state!==BTCxtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.pr, this.url, this.data.getToken(), this.data.getOfferer(), this.requiredBaseFee, this.requiredFeePPM);
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }

        const initTxs = await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        const claimTxs = await this.wrapper.contract.swapContract.txsClaimWithSecret(this.data, this.secret.toString("hex"), true, true);

        return initTxs.concat(claimTxs);

    }

    /**
     * Returns current state of the swap
     */
    getState() {
        return this.state;
    }

    /**
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    getPaymentHash(): Buffer {
        const decodedPR = bolt11.decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        return this.pr;
    }

    getQrData(): string {
        return "lightning:"+this.pr.toUpperCase();
    }

    getType(): SwapType {
        return SwapType.FROM_BTCLN;
    }

    /**
     * Estimated transaction fee for commitAndClaim tx
     */
    async getCommitAndClaimFee(): Promise<BN> {
        const commitFee = await this.getCommitFee();
        const claimFee = await this.getClaimFee();
        return commitFee.add(claimFee);
    }

    /**
     * Is this an LNURL-pay swap?
     */
    isLNURL(): boolean {
        return this.lnurl!=null;
    }

    /**
     * Gets the used LNURL or null if this is not an LNURL-pay swap
     */
    getLNURL(): string | null {
        return this.lnurl;
    }

}