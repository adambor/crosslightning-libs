
import {IToBTCWrapper} from "./IToBTCWrapper";
import {ISwap} from "../ISwap";
import * as BN from "bn.js";
import * as EventEmitter from "events";
import {SwapType} from "../SwapType";
import {SignatureVerificationError, SwapCommitStatus, SwapData} from "crosslightning-base";
import {TokenAddress} from "crosslightning-base";
import {tryWithRetries} from "../../utils/RetryUtils";

export abstract class IToBTCSwap<T extends SwapData> implements ISwap {

    state: ToBTCSwapState;

    readonly url: string;

    readonly expiry: number;
    data: T;

    swapFee: BN;
    readonly networkFee: BN;
    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    secret: string;

    readonly wrapper: IToBTCWrapper<T>;

    commitTxId: string;
    refundTxId: string;

    /**
     * Swap's event emitter
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    protected constructor(
        wrapper: IToBTCWrapper<T>,
        prOrObject: T | any,
        networkFee?: BN,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
        expiry?: number
    ) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(prefix!=null || timeout!=null || signature!=null || nonce!=null || url!=null) {
            this.state = ToBTCSwapState.CREATED;

            this.url = url;

            this.data = prOrObject;

            this.networkFee = networkFee;
            this.swapFee = swapFee;
            this.prefix = prefix;
            this.timeout = timeout;
            this.signature = signature;
            this.nonce = nonce;
            this.expiry = expiry;
        } else {
            this.state = prOrObject.state;

            this.url = prOrObject.url;

            this.secret = prOrObject.secret;

            this.data = prOrObject.data!=null ? new wrapper.swapDataDeserializer(prOrObject.data) : null;

            this.networkFee = prOrObject.networkFee==null ? null : new BN(prOrObject.networkFee);
            this.swapFee = prOrObject.swapFee==null ? null : new BN(prOrObject.swapFee);
            this.prefix = prOrObject.prefix;
            this.timeout = prOrObject.timeout;
            this.signature = prOrObject.signature;
            this.nonce = prOrObject.nonce;
            this.commitTxId = prOrObject.commitTxId;
            this.refundTxId = prOrObject.refundTxId;
            this.expiry = prOrObject.expiry;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    abstract getInAmount(): BN;

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    abstract getOutAmount(): BN;

    /**
     * Get's the bitcoin address/lightning invoice of the recipient
     */
    abstract getAddress(): string;

    /**
     * Returns the payment hash
     */
    abstract getPaymentHash(): Buffer;

    abstract getType(): SwapType;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN {
        return this.networkFee.add(this.swapFee);
    }

    getNetworkFee(): BN {
        return this.networkFee;
    }

    getSwapFee(): BN {
        return this.swapFee;
    }

    getInAmountWithoutFee(): BN {
        return this.getInAmount().sub(this.getFee());
    }

    /**
     * Returns if the swap can be committed/started
     */
    canCommit(): boolean {
        return this.state===ToBTCSwapState.CREATED;
    }

    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==ToBTCSwapState.CREATED) {
            throw new Error("Must be in CREATED state!");
        }

        console.log(this);

        // try {
        //     await this.wrapper.contract.swapContract.isValidClaimInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        // } catch (e) {
        //     console.error(e);
        //     this.state = ToBTCSwapState.FAILED;
        //     await this.save();
        //     throw new Error("Expired, please retry");
        // }

        let txResult;
        try {
            txResult = await this.wrapper.contract.swapContract.initPayIn(this.data, this.timeout, this.prefix, this.signature, this.nonce, !noWaitForConfirmation, abortSignal);
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                console.error(e);
                this.state = ToBTCSwapState.FAILED;
                await this.save();
                throw new Error("Expired, please retry");
            }
            throw e;
        }

        this.commitTxId = txResult;
        await this.save();

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

        return txResult;
    }

    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     */
    async txsCommit(): Promise<any[]> {
        if(this.state!==ToBTCSwapState.CREATED) {
            throw new Error("Must be in CREATED state!");
        }

        console.log(this);

        try {
            await tryWithRetries(
                () => this.wrapper.contract.swapContract.isValidClaimInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce),
                null,
                e => e instanceof SignatureVerificationError
            );
        } catch (e) {
            if(e instanceof SignatureVerificationError) {
                console.error(e);
                throw new Error("Expired, please retry");
            }
            throw e;
        }

        return await this.wrapper.contract.swapContract.txsInitPayIn(this.data, this.timeout, this.prefix, this.signature, this.nonce);
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===ToBTCSwapState.COMMITED) {
                resolve();
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.wrapper.contract.swapContract.getCommitStatus(this.data).then((status) => {
                    if(status!==SwapCommitStatus.NOT_COMMITED) {
                        abortController.abort();
                        if(this.state<ToBTCSwapState.COMMITED) {
                            this.state = ToBTCSwapState.COMMITED;
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
                if(swap.state===ToBTCSwapState.COMMITED) {
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
     * A blocking promise resolving when swap was concluded by the intermediary
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<boolean> {
        const abortController = new AbortController();

        if(abortSignal!=null) abortSignal.onabort = () => {
            abortController.abort();
        };

        abortController.signal.addEventListener("abort", () => {
            if(abortSignal!=null) abortSignal.onabort = null;
        });

        return Promise.race([
            new Promise<boolean>((resolve, reject) => {
                let listener;

                 listener = (swap) => {
                     if(swap.state===ToBTCSwapState.CLAIMED) {
                         console.log("IToBTCSwap: waitForPayment(): Triggered from on-chain listener!");
                         resolve(true);
                         abortController.abort();
                     }
                 };
                 this.events.on("swapState", listener);

                 abortController.signal.addEventListener("abort", () => {
                     this.events.removeListener("swapState", listener);
                 });
            }),
            (async() => {
                const result = await this.wrapper.contract.waitForRefundAuthorization(this.data, this.url, abortController.signal, checkIntervalSeconds); //Throws on abort

                abortController.abort();

                console.log("IToBTCSwap: waitForPayment(): Triggered from http request!");

                if(!result.is_paid) {
                    this.state = ToBTCSwapState.REFUNDABLE;

                    await this.save();

                    this.emitEvent();
                    return false;
                } else {
                    this.secret = result.secret;
                    await this.save();

                    return true;
                }
            })()
        ]);

    }

    /**
     * Returns whether a swap can be already refunded
     */
    canRefund(): boolean {
        return this.state===ToBTCSwapState.REFUNDABLE || this.wrapper.contract.swapContract.isExpired(this.data);
    }

    /**
     * Attempts a refund of the swap back to the initiator
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async refund(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==ToBTCSwapState.REFUNDABLE && !this.wrapper.contract.swapContract.isExpired(this.data)) {
            throw new Error("Must be in REFUNDABLE state!");
        }

        let txResult: string;
        if(this.wrapper.contract.swapContract.isExpired(this.data)) {
            txResult = await this.wrapper.contract.swapContract.refund(this.data, true, true, !noWaitForConfirmation, abortSignal);
        } else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.data, this.url);
            if(res.is_paid) {
                throw new Error("Payment was successful");
            }
            txResult = await this.wrapper.contract.swapContract.refundWithAuthorization(this.data, res.timeout, res.prefix, res.signature, true, true, !noWaitForConfirmation, abortSignal);
        }

        this.refundTxId = txResult;
        await this.save();

        if(!noWaitForConfirmation) {
            await this.waitTillRefunded(abortSignal);
            return txResult;
        }

        return txResult;
    }

    /**
     * Attempts a refund of the swap back to the initiator
     */
    async txsRefund(): Promise<any[]> {
        if(this.state!==ToBTCSwapState.REFUNDABLE && !this.wrapper.contract.swapContract.isExpired(this.data)) {
            throw new Error("Must be in REFUNDABLE state!");
        }

        if(this.wrapper.contract.swapContract.isExpired(this.data)) {
            return await this.wrapper.contract.swapContract.txsRefund(this.data, true, true);
        } else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.data, this.url);
            if(res.is_paid) {
                throw new Error("Payment was successful");
            }
            return await this.wrapper.contract.swapContract.txsRefundWithAuthorization(this.data, res.timeout, res.prefix, res.signature, true, true);
        }
    }

    /**
     * Returns a promise that resolves when swap is refunded
     *
     * @param abortSignal   AbortSignal
     */
    waitTillRefunded(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            if(this.state===ToBTCSwapState.REFUNDED) {
                resolve();
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.wrapper.contract.swapContract.isCommited(this.data).then((status) => {
                    if(!status) {
                        abortController.abort();
                        if(this.state!=ToBTCSwapState.CLAIMED) {
                            this.state = ToBTCSwapState.REFUNDED;
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
                if(swap.state===ToBTCSwapState.REFUNDED) {
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
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    serialize(): any{
        return {
            state: this.state,
            url: this.url,
            secret: this.secret,
            data: this.data!=null ? this.data.serialize() : null,
            networkFee: this.networkFee==null ? null : this.networkFee.toString(10),
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            nonce: this.nonce,
            commitTxId: this.commitTxId,
            refundTxId: this.refundTxId,
            expiry: this.expiry
        };
    }

    save(): Promise<void> {
        return this.wrapper.storage.saveSwapData(this);
    }

    getTxId(): string {
        return this.secret;
    }

    /**
     * Returns the address of the input token
     */
    getToken(): TokenAddress {
        return this.data.getToken();
    }

    /**
     * Returns the current state of the swap
     */
    getState(): ToBTCSwapState {
        return this.state;
    }

    getWrapper(): IToBTCWrapper<T> {
        return this.wrapper;
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): Promise<BN> {
        return this.getWrapper().contract.swapContract.getCommitFee();
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(): Promise<BN> {
        return this.getWrapper().contract.swapContract.getRefundFee();
    }

    /**
     * Returns expiry in UNIX millis
     */
    getExpiry(): number {
        return this.expiry;
    }
}

export enum ToBTCSwapState {
    REFUNDED = -2,
    FAILED = -1,
    CREATED = 0,
    COMMITED = 1,
    CLAIMED = 2,
    REFUNDABLE = 3
}
