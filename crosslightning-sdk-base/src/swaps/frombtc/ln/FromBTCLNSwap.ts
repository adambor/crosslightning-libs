import * as bolt11 from "bolt11";
import {FromBTCLNWrapper} from "./FromBTCLNWrapper";
import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapCommitStatus, SwapData} from "crosslightning-base";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {SignatureVerificationError} from "crosslightning-base";
import {PriceInfoType} from "../../ISwap";
import {LNURLWithdraw, LNURLWithdrawParamsWithUrl} from "../../ClientSwapContract";

export enum FromBTCLNSwapState {
    EXPIRED = -2,
    FAILED = -1,
    PR_CREATED = 0,
    PR_PAID = 1,
    CLAIM_COMMITED = 2,
    CLAIM_CLAIMED = 3
}

export class FromBTCLNSwap<T extends SwapData> extends IFromBTCSwap<T> {

    state: FromBTCLNSwapState;

    //State: PR_CREATED
    readonly pr: string;
    readonly secret: Buffer;
    readonly requiredBaseFee: BN;
    readonly requiredFeePPM: BN;
    readonly expectedOut: BN;
    lnurl: string;
    lnurlK1: string;
    lnurlCallback: string;
    prPosted: boolean;
    callbackPromise: Promise<void>;


    constructor(
        wrapper: FromBTCLNWrapper<T>,
        pr: string,
        secret: Buffer,
        url: string,
        data: T,
        swapFee: BN,
        requiredBaseFee: BN,
        requiredFeePPM: BN,
        expectedOut: BN,
        pricing: PriceInfoType,
        feeRate: any,
        lnurl: string,
        callbackPromise: Promise<void>,
        lnurlK1: string,
        lnurlCallback: string,
        prPosted: boolean
    );
    constructor(wrapper: FromBTCLNWrapper<T>, obj: any);

    constructor(
        wrapper: FromBTCLNWrapper<T>,
        prOrObject: string | any,
        secret?: Buffer,
        url?: string,
        data?: T,
        swapFee?: BN,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        expectedOut?: BN,
        pricing?: PriceInfoType,
        feeRate?: any,
        lnurl?: string,
        callbackPromise?: Promise<void>,
        lnurlK1?: string,
        lnurlCallback?: string,
        prPosted?: boolean
    ) {
        if(typeof(prOrObject)==="string") {
            super(wrapper, url, data, swapFee, null, null, null, feeRate, null, pricing);
            this.state = FromBTCLNSwapState.PR_CREATED;

            this.pr = prOrObject;
            this.secret = secret;
            this.requiredBaseFee = requiredBaseFee;
            this.requiredFeePPM = requiredFeePPM;
            this.expectedOut = expectedOut;
            this.lnurl = lnurl;
            this.callbackPromise = callbackPromise;
            this.lnurlK1 = lnurlK1;
            this.lnurlCallback = lnurlCallback;
            this.prPosted = prPosted;
        } else {
            super(wrapper, prOrObject);
            this.state = prOrObject.state;

            this.pr = prOrObject.pr;
            this.secret = Buffer.from(prOrObject.secret, "hex");
            this.requiredBaseFee = prOrObject.requiredBaseFee==null ? null : new BN(prOrObject.requiredBaseFee);
            this.requiredFeePPM = prOrObject.requiredFeePPM==null ? null : new BN(prOrObject.requiredFeePPM);
            this.expectedOut = prOrObject.expectedOut==null ? null : new BN(prOrObject.expectedOut);
            this.lnurl = prOrObject.lnurl;
            this.lnurlK1 = prOrObject.lnurlK1;
            this.lnurlCallback = prOrObject.lnurlCallback;
            this.prPosted = prOrObject.prPosted;
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
        if(this.state!==FromBTCLNSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const abortController = new AbortController();

        if(abortSignal!=null) abortSignal.onabort = () => abortController.abort();

        console.log("Waiting for payment....");

        let callbackError = null;

        if(this.lnurl!=null && !this.prPosted) {
            this.callbackPromise = this.wrapper.contract.postInvoiceToLNURLWithdraw(this.pr, this.lnurlK1, this.lnurlCallback);
            this.prPosted = true;
            await this.save();
        }

        let existingCallbackPromise;

        let changeListener = () => {
            if(existingCallbackPromise==null) {
                if(this.callbackPromise!=null) {
                    this.callbackPromise.catch(e => {
                        callbackError = e;
                        abortController.abort();
                    });
                    existingCallbackPromise = this.callbackPromise;
                }
            }
        };
        changeListener();
        this.events.addListener("swapState", changeListener);

        let result;
        try {
            result = await this.wrapper.contract.waitForIncomingPaymentAuthorization(
                this.pr,
                this.url,
                this.data.getToken(),
                this.data.getOfferer(),
                this.requiredBaseFee,
                this.requiredFeePPM,
                this.data.getSecurityDeposit(),
                this.data.getAmount(),
                this.feeRate,
                abortController.signal,
                checkIntervalSeconds
            );
        } catch (e) {
            this.events.removeListener("swapState", changeListener);
            if(callbackError!=null) throw callbackError;
            throw e;
        }
        this.events.removeListener("swapState", changeListener);

        if(abortController.signal.aborted) {
            if(callbackError!=null) throw callbackError;
            throw new Error("Aborted");
        }

        this.state = FromBTCLNSwapState.PR_PAID;

        this.data = result.data;
        this.prefix = result.prefix;
        this.timeout = result.timeout;
        this.signature = result.signature;
        this.expiry = result.expiry;
        if(result.pricingInfo!=null) this.pricingInfo = result.pricingInfo;

        await this.save();

        this.emitEvent();
    }

    /**
     * Pay the generated lightning network invoice with LNURL-withdraw
     */
    async settleWithLNURLWithdraw(lnurl: string | LNURLWithdraw, noInstantReceive?: boolean): Promise<void> {
        const result = await this.getWrapper().contract.settleWithLNURLWithdraw(typeof(lnurl)==="string" ? lnurl : lnurl.params, this.pr, noInstantReceive);
        this.lnurl = typeof(lnurl)==="string" ? lnurl : lnurl.params.url;
        this.lnurlCallback = result.withdrawRequest.callback;
        this.lnurlK1 = result.withdrawRequest.k1;
        this.prPosted = !noInstantReceive;
        this.callbackPromise = result.lnurlCallbackResult;
        await this.save();
        await this.emitEvent();
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        return this.state===FromBTCLNSwapState.PR_PAID;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     * @param skipChecks                Skip checks like making sure init signature is still valid and swap wasn't commited yet (this is handled on swap creation, if you commit right after quoting, you can skipChecks)
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        if(this.state!==FromBTCLNSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        let txResult;
        try {
            txResult = await this.wrapper.contract.swapContract.init(this.data, this.timeout, this.prefix, this.signature, null, !noWaitForConfirmation, skipChecks, abortSignal, this.feeRate);
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                throw new Error("Request timed out!");
            }
            throw e;
        }

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

        // this.state = FromBTCLNSwapState.CLAIM_COMMITED;
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
    async txsCommit(skipChecks?: boolean): Promise<any[]> {
        if(this.state!==FromBTCLNSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        let txs: any[];
        try {
            txs = await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, null, skipChecks, this.feeRate);
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                throw new Error("Request timed out!")
            } else {
                throw e;
            }
        }

        return txs;
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.wrapper.contract.swapContract.getCommitStatus(this.data).then((status) => {
                    if(status!==SwapCommitStatus.NOT_COMMITED) {
                        abortController.abort();
                        if(this.state<FromBTCLNSwapState.CLAIM_COMMITED) {
                            this.state = FromBTCLNSwapState.CLAIM_COMMITED;
                            this.save().then(() => {
                                this.emitEvent();
                                if(abortSignal!=null && abortSignal.aborted) return;
                                resolve();
                            });
                        } else {
                            resolve();
                        }
                    }
                }).catch(e => console.error(e));
            }, 5000);
            abortController.signal.addEventListener("abort", () => clearInterval(intervalWatchdog));

            const listener = (swap) => {
                if(swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                    abortController.abort();
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            abortController.signal.addEventListener("abort", () => this.events.removeListener("swapState", listener));

            abortController.signal.addEventListener("abort", () => {
                if(abortSignal!=null) abortSignal.onabort = null;
            });

            if(abortSignal!=null) abortSignal.onabort = () => {
                abortController.abort();
                reject("Aborted");
            };
        });
    }

    /**
     * Returns if the swap can be claimed
     */
    canClaim(): boolean {
        return this.state===FromBTCLNSwapState.CLAIM_COMMITED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }

        const txResult = await this.wrapper.contract.swapContract.claimWithSecret(this.data, this.secret.toString("hex"), true, true, !noWaitForConfirmation, abortSignal);

        this.claimTxId = txResult;
        this.state = FromBTCLNSwapState.CLAIM_CLAIMED;
        await this.save();
        this.emitEvent();

        // if(!noWaitForConfirmation) {
        //     await this.waitTillClaimed(abortSignal);
        //     return txResult;
        // }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        // this.state = FromBTCLNSwapState.CLAIM_CLAIMED;
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
        if(this.state!==FromBTCLNSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }

        return await this.wrapper.contract.swapContract.txsClaimWithSecret(this.data, this.secret.toString("hex"), true, true);
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCLNSwapState.CLAIM_CLAIMED) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.wrapper.contract.swapContract.getCommitStatus(this.data).then((status) => {
                    if(status===SwapCommitStatus.PAID) {
                        abortController.abort();
                        if(this.state<FromBTCLNSwapState.CLAIM_CLAIMED) {
                            this.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                            this.save().then(() => {
                                this.emitEvent();
                                if(abortSignal!=null && abortSignal.aborted) return;
                                resolve();
                            });
                        } else {
                            resolve();
                        }
                    }
                }).catch(e => console.error(e));
            }, 5000);
            abortController.signal.addEventListener("abort", () => clearInterval(intervalWatchdog));

            const listener = (swap) => {
                if(swap.state===FromBTCLNSwapState.CLAIM_CLAIMED) {
                    abortController.abort();
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            abortController.signal.addEventListener("abort", () => this.events.removeListener("swapState", listener));

            abortController.signal.addEventListener("abort", () => {
                if(abortSignal!=null) abortSignal.onabort = null;
            });

            if(abortSignal!=null) abortSignal.onabort = () => {
                abortController.abort();
                reject("Aborted");
            };
        });
    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     *
     * @param abortSignal       Abort signal
     * @param skipChecks                Skip checks like making sure init signature is still valid and swap wasn't commited yet (this is handled on swap creation, if you commit right after quoting, you can skipChecks)
     */
    async commitAndClaim(abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string[]> {

        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            return [
                null,
                await this.claim(false, abortSignal)
            ];
        }

        if(this.state!==FromBTCLNSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        let txResult;
        try {
            txResult = await this.wrapper.contract.swapContract.initAndClaimWithSecret(
                this.data,
                this.timeout,
                this.prefix,
                this.signature,
                this.secret.toString("hex"),
                true,
                skipChecks,
                abortSignal,
                this.feeRate
            );
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                const result = await this.wrapper.contract.getPaymentAuthorization(
                    this.pr,
                    this.url,
                    this.data.getToken(),
                    this.data.getOfferer(),
                    this.requiredBaseFee,
                    this.requiredFeePPM,
                    this.data.getSecurityDeposit(),
                    this.data.getAmount(),
                    this.feeRate
                );

                this.data = result.data;
                this.prefix = result.prefix;
                this.timeout = result.timeout;
                this.signature = result.signature;

                txResult = await this.wrapper.contract.swapContract.initAndClaimWithSecret(
                    this.data,
                    this.timeout,
                    this.prefix,
                    this.signature,
                    this.secret.toString("hex"),
                    true,
                    skipChecks,
                    abortSignal,
                    this.feeRate
                );
            } else {
                throw e;
            }
        }

        this.commitTxId = txResult[0] || this.commitTxId;
        this.claimTxId = txResult[1] || this.claimTxId;
        this.state = FromBTCLNSwapState.CLAIM_CLAIMED;
        await this.save();
        this.emitEvent();

        // await this.waitTillClaimed(abortSignal);

        console.log("Claim tx confirmed!");

        return txResult;

    }

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     */
    async txsCommitAndClaim(skipChecks?: boolean): Promise<any[]> {

        if(this.state===FromBTCLNSwapState.CLAIM_COMMITED) {
            return await this.txsClaim();
        }

        if(this.state!==FromBTCLNSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        let initTxs: any[];
        try {
            initTxs = await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, null, skipChecks, this.feeRate);
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                const result = await this.wrapper.contract.getPaymentAuthorization(
                    this.pr,
                    this.url,
                    this.data.getToken(),
                    this.data.getOfferer(),
                    this.requiredBaseFee,
                    this.requiredFeePPM,
                    this.data.getSecurityDeposit(),
                    this.data.getAmount(),
                    this.feeRate
                );

                this.data = result.data;
                this.prefix = result.prefix;
                this.timeout = result.timeout;
                this.signature = result.signature;

                initTxs = await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, null, skipChecks, this.feeRate);
            } else {
                throw e;
            }
        }

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
     * @fires FromBTCLNWrapper#swapState
     * @fires FromBTCLNSwap#swapState
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
        const commitFee = await tryWithRetries(() => this.getCommitFee());
        const claimFee = await tryWithRetries(() => this.getClaimFee());
        return commitFee.add(claimFee);
    }

    getTimeoutTime(): number {
        if(this.pr==null) return null;
        const decoded = bolt11.decode(this.pr);
        return (decoded.timeExpireDate*1000);
    }

    /**
     * Is this an LNURL-withdraw swap?
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