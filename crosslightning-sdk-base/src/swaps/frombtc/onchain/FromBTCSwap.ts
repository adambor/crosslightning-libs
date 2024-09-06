import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import {address} from "bitcoinjs-lib";
import * as createHash from "create-hash";
import {FromBTCWrapper} from "./FromBTCWrapper";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {isISwapInit, ISwapInit, Token} from "../../ISwap";
import {Buffer} from "buffer";

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

export class FromBTCSwap<T extends SwapData, TXType = any> extends IFromBTCSwap<T, FromBTCSwapState, TXType> {
    protected readonly TYPE = SwapType.FROM_BTC;

    protected readonly PRE_COMMIT_STATE = FromBTCSwapState.PR_CREATED;
    protected readonly COMMIT_STATE = FromBTCSwapState.CLAIM_COMMITED;
    protected readonly CLAIM_STATE = FromBTCSwapState.CLAIM_CLAIMED;
    protected readonly FAIL_STATE = FromBTCSwapState.FAILED;

    readonly wrapper: FromBTCWrapper<T, TXType>;

    readonly address: string;
    readonly amount: BN;

    txId?: string;
    vout?: number;

    constructor(wrapper: FromBTCWrapper<T, TXType>, init: FromBTCSwapInit<T>);
    constructor(wrapper: FromBTCWrapper<T, TXType>, obj: any);
    constructor(wrapper: FromBTCWrapper<T, TXType>, initOrObject: FromBTCSwapInit<T> | any) {
        if(isFromBTCSwapInit(initOrObject)) initOrObject.url += "/frombtc";
        super(wrapper, initOrObject);
        if(isFromBTCSwapInit(initOrObject)) {
            this.state = FromBTCSwapState.PR_CREATED;
        } else {
            this.address = initOrObject.address;
            this.amount = new BN(initOrObject.amount);
            this.txId = initOrObject.txId;
            this.vout = initOrObject.vout;
        }
        this.tryCalculateSwapFee();
    }


    //////////////////////////////
    //// Getters & utils

    getInToken(): {chain: "BTC", lightning: false} {
        return {
            chain: "BTC",
            lightning: false
        };
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = address.toOutputScript(this.address, this.wrapper.options.bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    /**
     * Returns bitcoin address where the on-chain BTC should be sent to
     */
    getBitcoinAddress(): string {
        if(this.state===FromBTCSwapState.PR_CREATED) return null;
        return this.address;
    }

    getQrData(): string {
        if(this.state===FromBTCSwapState.PR_CREATED) return null;
        return "bitcoin:"+this.address+"?amount="+encodeURIComponent((this.amount.toNumber()/100000000).toString(10));
    }

    /**
     * Returns timeout time (in UNIX milliseconds) when the on-chain address will expire and no funds should be sent
     *  to that address anymore
     */
    getTimeoutTime(): number {
        return this.wrapper.getOnchainSendTimeout(this.data).toNumber()*1000;
    }

    isFinished(): boolean {
        return this.state===FromBTCSwapState.CLAIM_CLAIMED || this.state===FromBTCSwapState.QUOTE_EXPIRED || this.state===FromBTCSwapState.FAILED;
    }

    isClaimable(): boolean {
        return this.state===FromBTCSwapState.BTC_TX_CONFIRMED || (this.state===FromBTCSwapState.CLAIM_COMMITED && !this.wrapper.contract.isExpired(this.data) && this.getTimeoutTime()>Date.now());
    }

    isSuccessful(): boolean {
        return this.state===FromBTCSwapState.CLAIM_CLAIMED;
    }

    isFailed(): boolean {
        return this.state===FromBTCSwapState.FAILED;
    }

    isQuoteExpired(): boolean {
        return this.state===FromBTCSwapState.QUOTE_EXPIRED;
    }

    canCommit(): boolean {
        if(this.state!==FromBTCSwapState.PR_CREATED) return false;
        const expiry = this.wrapper.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        return expiry.sub(currentTimestamp).gte(new BN(this.wrapper.options.minSendWindow));
    }

    canClaim(): boolean {
        return this.state===FromBTCSwapState.BTC_TX_CONFIRMED;
    }


    //////////////////////////////
    //// Amounts & fees

    getInAmount(): BN {
        return new BN(this.amount);
    }

    /**
     * Returns claimer bounty, acting as a reward for watchtowers to claim the swap automatically
     */
    getClaimerBounty(): BN {
        return this.data.getClaimerBounty();
    }


    //////////////////////////////
    //// Bitcoin tx

    /**
     * Waits till the bitcoin transaction confirms and swap becomes claimable
     *
     * @param abortSignal Abort signal
     * @param checkIntervalSeconds How often to check the bitcoin transaction
     * @param updateCallback Callback called when txId is found, and also called with subsequent confirmations
     * @throws {Error} if in invalid state (must be CLAIM_COMMITED)
     */
    async waitForBitcoinTransaction(
        abortSignal?: AbortSignal,
        checkIntervalSeconds?: number,
        updateCallback?: (txId: string, confirmations: number, targetConfirmations: number, txEtaMs: number) => void
    ): Promise<void> {
        if(this.state!==FromBTCSwapState.CLAIM_COMMITED) throw new Error("Must be in COMMITED state!");

        const result = await this.wrapper.btcRpc.waitForAddressTxo(
            this.address,
            this.getTxoHash(),
            this.data.getConfirmations(),
            (confirmations: number, txId: string, vout: number, txEtaMs: number) => {
                if(updateCallback!=null) updateCallback(txId, confirmations, this.data.getConfirmations(), txEtaMs);
            },
            abortSignal,
            checkIntervalSeconds
        );

        if(abortSignal!=null) abortSignal.throwIfAborted();

        this.txId = result.tx.txid;
        this.vout = result.vout;
        if(this.state<FromBTCSwapState.BTC_TX_CONFIRMED) {
            this.state = FromBTCSwapState.BTC_TX_CONFIRMED;
        }

        await this._saveAndEmit();
    }

    /**
     * Checks whether a bitcoin payment was already made, returns the payment or null when no payment has been made.
     */
    async getBitcoinPayment(): Promise<{
        txId: string,
        vout: number,
        confirmations: number,
        targetConfirmations: number
    } | null> {
        const result = await this.wrapper.btcRpc.checkAddressTxos(this.address, this.getTxoHash());
        if(result==null) return null;

        return {
            txId: result.tx.txid,
            vout: result.vout,
            confirmations: result.tx.confirmations,
            targetConfirmations: this.data.getConfirmations()
        }
    }


    //////////////////////////////
    //// Claim

    /**
     * Returns transactions required to claim the swap on-chain (and possibly also sync the bitcoin light client)
     *  after a bitcoin transaction was sent and confirmed
     * @throws {Error} If the swap is in invalid state (must be BTC_TX_CONFIRMED)
     */
    async txsClaim(): Promise<TXType[]> {
        if(!this.canClaim()) throw new Error("Must be in BTC_TX_CONFIRMED state!");

        const tx = await this.wrapper.btcRpc.getTransaction(this.txId);

        return await this.wrapper.contract.txsClaimWithTxData(this.data, tx.blockheight, {
            blockhash: tx.blockhash,
            confirmations: this.data.getConfirmations(),
            txid: tx.txid,
            hex: tx.hex
        }, this.vout, null, this.wrapper.synchronizer, true);
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