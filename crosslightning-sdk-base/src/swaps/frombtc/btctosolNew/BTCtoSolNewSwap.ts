import {IBTCxtoSolSwap} from "../IBTCxtoSolSwap";
import {SwapType} from "../../SwapType";
import * as bitcoin from "bitcoinjs-lib";
import {createHash, randomBytes} from "crypto-browserify";
import {ChainUtils} from "../../../btc/ChainUtils";
import {BTCtoSolNewWrapper} from "./BTCtoSolNewWrapper";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";

export enum BTCtoSolNewSwapState {
    FAILED = -1,
    PR_CREATED = 0,
    CLAIM_COMMITED = 1,
    BTC_TX_CONFIRMED = 2,
    CLAIM_CLAIMED = 3
}

export class BTCtoSolNewSwap<T extends SwapData> extends IBTCxtoSolSwap<T> {

    state: BTCtoSolNewSwapState;

    txId: string;
    vout: number;

    readonly secret: string;

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;

    constructor(
        wrapper: BTCtoSolNewWrapper<T>,
        address: string,
        amount: BN,
        url: string,
        data: T,
        swapFee: BN,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        expiry: number
    );
    constructor(wrapper: BTCtoSolNewWrapper<T>, obj: any);

    constructor(
        wrapper: BTCtoSolNewWrapper<T>,
        addressOrObject: string | any,
        amount?: BN,
        url?: string,
        data?: T,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        expiry?: number
    ) {
        if(typeof(addressOrObject)==="string") {
            super(wrapper, url, data, swapFee, prefix, timeout, signature, nonce, expiry);
            this.state = BTCtoSolNewSwapState.PR_CREATED;

            this.address = addressOrObject;
            this.amount = amount;

            this.secret = randomBytes(32).toString("hex");
        } else {
            super(wrapper, addressOrObject);
            this.state = addressOrObject.state;

            this.address = addressOrObject.address;
            this.amount = new BN(addressOrObject.amount);

            this.txId = addressOrObject.txId;
            this.vout = addressOrObject.vout;
            this.secret = addressOrObject.secret;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN {
        return this.data.getAmount();
    }

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount(): BN {
        return new BN(this.amount);
    }

    serialize(): any {
        const partiallySerialized = super.serialize();

        partiallySerialized.state = this.state;
        partiallySerialized.address = this.address;
        partiallySerialized.amount = this.amount.toString(10);
        partiallySerialized.txId = this.txId;
        partiallySerialized.vout = this.vout;
        partiallySerialized.secret = this.secret;

        return partiallySerialized;
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number, updateCallback?: (txId: string, confirmations: number, targetConfirmations: number) => void): Promise<void> {
        if(this.state!==BTCtoSolNewSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const result = await ChainUtils.waitForAddressTxo(this.address, this.getTxoHash(), this.data.getConfirmations(), (confirmations: number, txId: string, vout: number) => {
            if(updateCallback!=null) {
                updateCallback(txId, confirmations, this.data.getConfirmations());
            }
        }, abortSignal, checkIntervalSeconds);

        if(abortSignal==null && abortSignal.aborted) throw new Error("Aborted");

        this.txId = result.tx.txid;
        this.vout = result.vout;
        if(this.state<BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            this.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
        }

        await this.save();

        this.emitEvent();
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            return false;
        }
        const expiry = this.wrapper.contract.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(this.wrapper.contract.options.minSendWindow))) {
            return false;
        }
        return true;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an PTLC
     * Important: Make sure this transaction is confirmed and only after it is display the address to user
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = this.wrapper.contract.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(this.wrapper.contract.options.minSendWindow))) {
            throw new Error("Send window too low");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        const txResult = await this.wrapper.contract.swapContract.init(this.data, this.timeout, this.prefix, this.signature, this.nonce, this.getTxoHash(), !noWaitForConfirmation, abortSignal);

        this.commitTxId = txResult;
        await this.save();

        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

        // this.state = BTCtoSolNewSwapState.CLAIM_COMMITED;
        //
        // await this.save();
        //
        // this.emitEvent();

        return txResult;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an PTLC
     * Important: Make sure this transaction is confirmed and only after it is display the address to user
     */
    async txsCommit(): Promise<any[]> {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = this.wrapper.contract.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(this.wrapper.contract.options.minSendWindow))) {
            throw new Error("Send window too low");
        }

        try {
            await this.wrapper.contract.swapContract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        return await this.wrapper.contract.swapContract.txsInit(this.data, this.timeout, this.prefix, this.signature, this.nonce, this.getTxoHash());
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
            if(this.state===BTCtoSolNewSwapState.CLAIM_COMMITED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED) {
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
        return this.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            throw new Error("Must be in BTC_TX_CONFIRMED state!");
        }

        const txData = await ChainUtils.getTransaction(this.txId);
        const rawTx = await ChainUtils.getRawTransaction(this.txId);

        const txResult = await this.wrapper.contract.swapContract.claimWithTxData(this.data, txData.status.block_height, {
            blockhash: txData.status.block_hash,
            confirmations: this.data.getConfirmations(),
            txid: txData.txid,
            hex: rawTx.toString("hex")
        }, this.vout, null, (this.wrapper as BTCtoSolNewWrapper<T>).synchronizer, true, !noWaitForConfirmation, abortSignal);

        this.claimTxId = txResult;

        if(!noWaitForConfirmation) {
            await this.save();
            await this.waitTillClaimed(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        this.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
        await this.save();

        this.emitEvent();

        return txResult;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     */
    async txsClaim(): Promise<any[]> {
        if(this.state!==BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            throw new Error("Must be in BTC_TX_CONFIRMED state!");
        }

        const txData = await ChainUtils.getTransaction(this.txId);
        const rawTx = await ChainUtils.getRawTransaction(this.txId);

        return await this.wrapper.contract.swapContract.txsClaimWithTxData(this.data, txData.status.block_height, {
            blockhash: txData.status.block_hash,
            confirmations: this.data.getConfirmations(),
            txid: txData.txid,
            hex: rawTx.toString("hex")
        }, this.vout, null, (this.wrapper as BTCtoSolNewWrapper<T>).synchronizer, true);
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
            if(this.state===BTCtoSolNewSwapState.CLAIM_CLAIMED) {
                resolve();
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCtoSolNewSwapState.CLAIM_CLAIMED) {
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
     * Returns current state of the swap
     */
    getState() {
        return this.state;
    }

    /**
     * @fires BTCtoSolWrapper#swapState
     * @fires BTCtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    getPaymentHash(): Buffer {
        return Buffer.from(this.data.getHash(), "hex");
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, this.wrapper.contract.options.bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    getAddress(): string {
        return this.state===BTCtoSolNewSwapState.PR_CREATED ? null : this.address;
    }

    getQrData(): string {
        return this.state===BTCtoSolNewSwapState.PR_CREATED ? null : "bitcoin:"+this.address+"?amount="+encodeURIComponent((this.amount.toNumber()/100000000).toString(10));
    }

    getType(): SwapType {
        return SwapType.FROM_BTC;
    }

    getTimeoutTime(): number {
        return this.wrapper.contract.getOnchainSendTimeout(this.data).toNumber()*1000;
    }

    getClaimerBounty(): BN {
        return this.data.getClaimerBounty();
    }

}