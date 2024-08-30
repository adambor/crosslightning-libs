import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import * as bitcoin from "bitcoinjs-lib";
import randomBytes from "randombytes";
import createHash from "create-hash";
import {MempoolApi} from "../../../btc/MempoolApi";
import {FromBTCWrapper} from "./FromBTCWrapper";
import * as BN from "bn.js";
import {SignatureVerificationError, SwapData} from "crosslightning-base";
import {Fee, isISwapInit, ISwapInit, PriceInfoType, Token} from "../../ISwap";
import {Buffer} from "buffer";
import {tryWithRetries} from "../../../utils/RetryUtils";

export enum FromBTCSwapState {
    FAILED = -2,
    QUOTE_EXPIRED = -1,
    PR_CREATED = 0,
    CLAIM_COMMITED = 1,
    BTC_TX_CONFIRMED = 2,
    CLAIM_CLAIMED = 3
}

export type FromBTCSwapInit<T extends SwapData> = ISwapInit<T> & {
    address: string;
    amount: BN;
};

export function isFromBTCSwapInit<T extends SwapData>(obj: any): obj is FromBTCSwapInit<T> {
    return typeof(obj.address)==="string" &&
        BN.isBN(obj.amount) &&
        isISwapInit<T>(obj);
}

export class FromBTCSwap<T extends SwapData> extends IFromBTCSwap<T, FromBTCSwapState> {
    protected readonly TYPE = SwapType.FROM_BTC;
    protected readonly COMMIT_STATE = FromBTCSwapState.CLAIM_COMMITED;
    protected readonly CLAIM_STATE = FromBTCSwapState.CLAIM_CLAIMED;
    protected readonly FAIL_STATE = FromBTCSwapState.FAILED;

    readonly address: string;
    readonly amount: BN;

    txId?: string;
    vout?: number;

    constructor(wrapper: FromBTCWrapper<T>, init: FromBTCSwapInit<T>);
    constructor(wrapper: FromBTCWrapper<T>, obj: any);

    constructor(wrapper: FromBTCWrapper<T>, initOrObject: FromBTCSwapInit<T> | any) {
        super(wrapper, initOrObject);
        if(!isFromBTCSwapInit(initOrObject)) {
            this.address = initOrObject.address;
            this.amount = new BN(initOrObject.amount);
            this.txId = initOrObject.txId;
            this.vout = initOrObject.vout;
        }
        this.tryCalculateSwapFee();
    }


    //////////////////////////////
    //// Getters & utils

    getInToken(): Token {
        return {
            chain: "BTC",
            lightning: false
        };
    }

    /**
     * Checks whether a bitcoin payment was already made, returns the payment or null when no payment has been made.
     */
    async getBitcoinPayment(): Promise<{txId: string, confirmations: number, targetConfirmations: number} | null> {
        const result = await MempoolApi.checkAddressTxos(this.address, this.getTxoHash());

        if(result==null) return null;

        let confirmations = 0;
        if(result.tx.status.confirmed) {
            const tipHeight = await MempoolApi.getTipBlockHeight();
            confirmations = tipHeight-result.tx.status.block_height+1;
        }

        return {
            txId: result.tx.txid,
            confirmations,
            targetConfirmations: this.data.getConfirmations()
        }
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, this.wrapper.contract.options.bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    getAddress(): string {
        if(this.state===FromBTCSwapState.PR_CREATED) return null;
        return this.address;
    }

    getQrData(): string {
        if(this.state===FromBTCSwapState.PR_CREATED) return null;
        return "bitcoin:"+this.address+"?amount="+encodeURIComponent((this.amount.toNumber()/100000000).toString(10));
    }

    getTimeoutTime(): number {
        return this.wrapper.contract.getOnchainSendTimeout(this.data).toNumber()*1000;
    }

    /**
     * Returns whether the swap is finished and in its terminal state (this can mean successful, refunded or failed)
     */
    isFinished(): boolean {
        return this.state===FromBTCSwapState.CLAIM_CLAIMED || this.state===FromBTCSwapState.QUOTE_EXPIRED || this.state===FromBTCSwapState.FAILED;
    }

    isClaimable(): boolean {
        return this.state===FromBTCSwapState.BTC_TX_CONFIRMED || (this.state===FromBTCSwapState.CLAIM_COMMITED && !this.wrapper.contract.swapContract.isExpired(this.data) && this.getTimeoutTime()>Date.now());
    }

    isQuoteExpired(): boolean {
        return this.state===FromBTCSwapState.QUOTE_EXPIRED;
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        if(this.state!==FromBTCSwapState.PR_CREATED) return false;
        const expiry = this.wrapper.contract.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        return expiry.sub(currentTimestamp).gte(new BN(this.wrapper.contract.options.minSendWindow));
    }

    /**
     * Returns if the swap can be claimed
     */
    canClaim(): boolean {
        return this.state===FromBTCSwapState.BTC_TX_CONFIRMED;
    }


    //////////////////////////////
    //// Amounts & fees

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount(): BN {
        return new BN(this.amount);
    }

    getClaimerBounty(): BN {
        return this.data.getClaimerBounty();
    }


    //////////////////////////////
    //// Bitcoin tx

    /**
     * Waits till the bitcoin transaction confirms and swap becomes claimable
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    async waitForBitcoinTransaction(
        abortSignal?: AbortSignal,
        checkIntervalSeconds?: number,
        updateCallback?: (txId: string, confirmations: number, targetConfirmations: number, txEtaMs: number) => void
    ): Promise<void> {
        if(this.state!==FromBTCSwapState.CLAIM_COMMITED) throw new Error("Must be in COMMITED state!");

        const result = await this.wrapper.contract.btcRpc.waitForAddressTxo(this.address, this.getTxoHash(), this.data.getConfirmations(), (confirmations: number, txId: string, vout: number, txEtaMs: number) => {
            if(updateCallback!=null) updateCallback(txId, confirmations, this.data.getConfirmations(), txEtaMs);
        }, abortSignal, checkIntervalSeconds);

        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");

        this.txId = result.tx.txid;
        this.vout = result.vout;
        if(this.state<FromBTCSwapState.BTC_TX_CONFIRMED) {
            this.state = FromBTCSwapState.BTC_TX_CONFIRMED;
        }

        await this._saveAndEmit();
    }


    //////////////////////////////
    //// Claim

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     */
    async txsClaim(): Promise<any[]> {
        if(!this.canClaim()) throw new Error("Must be in BTC_TX_CONFIRMED state!");

        const txData = await MempoolApi.getTransaction(this.txId);
        const rawTx = await MempoolApi.getRawTransaction(this.txId);

        return await this.wrapper.contract.swapContract.txsClaimWithTxData(this.data, txData.status.block_height, {
            blockhash: txData.status.block_hash,
            confirmations: this.data.getConfirmations(),
            txid: txData.txid,
            hex: rawTx.toString("hex")
        }, this.vout, null, (this.wrapper as FromBTCWrapper<T>).synchronizer, true);
    }


    //////////////////////////////
    //// Storage

    serialize(): any {
        return {
            ...super.serialize(),
            address: this.address,
            amount: this.amount.toString(10),
            txId: this.txId,
            vout: this.vout
        };
    }

}