import {IFromBTCSwap} from "../IFromBTCSwap";
import {SwapType} from "../../SwapType";
import {address} from "bitcoinjs-lib";
import * as createHash from "create-hash";
import {FromBTCWrapper} from "./FromBTCWrapper";
import * as BN from "bn.js";
import {ChainType, SwapCommitStatus, SwapData} from "crosslightning-base";
import {isISwapInit, ISwapInit} from "../../ISwap";
import {Buffer} from "buffer";
import {BitcoinTokens, BtcToken, SCToken, TokenAmount, toTokenAmount} from "../../Tokens";
import {extendAbortController} from "../../../utils/Utils";

export enum FromBTCSwapState {
    FAILED = -4,
    EXPIRED = -3,
    QUOTE_EXPIRED = -2,
    QUOTE_SOFT_EXPIRED = -1,
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

export class FromBTCSwap<T extends ChainType = ChainType> extends IFromBTCSwap<T, FromBTCSwapState> {
    protected readonly inputToken: BtcToken<false> = BitcoinTokens.BTC;
    protected readonly TYPE = SwapType.FROM_BTC;

    readonly wrapper: FromBTCWrapper<T>;

    readonly address: string;
    readonly amount: BN;

    txId?: string;
    vout?: number;

    constructor(wrapper: FromBTCWrapper<T>, init: FromBTCSwapInit<T["Data"]>);
    constructor(wrapper: FromBTCWrapper<T>, obj: any);
    constructor(wrapper: FromBTCWrapper<T>, initOrObject: FromBTCSwapInit<T["Data"]> | any) {
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

    protected upgradeVersion() {
        if(this.version == null) {
            switch(this.state) {
                case -2:
                    this.state = FromBTCSwapState.FAILED
                    break;
                case -1:
                    this.state = FromBTCSwapState.QUOTE_EXPIRED
                    break;
                case 0:
                    this.state = FromBTCSwapState.PR_CREATED
                    break;
                case 1:
                    this.state = FromBTCSwapState.CLAIM_COMMITED
                    break;
                case 2:
                    this.state = FromBTCSwapState.BTC_TX_CONFIRMED
                    break;
                case 3:
                    this.state = FromBTCSwapState.CLAIM_CLAIMED
                    break;
            }
            this.version = 1;
        }
    }


    //////////////////////////////
    //// Getters & utils

    getTxoHash(): Buffer {
        const parsedOutputScript = address.toOutputScript(this.address, this.wrapper.options.bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    getAddress(): string {
        return this.address;
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
        return this.state===FromBTCSwapState.BTC_TX_CONFIRMED;
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

    isQuoteSoftExpired(): boolean {
        return this.state===FromBTCSwapState.QUOTE_EXPIRED || this.state===FromBTCSwapState.QUOTE_SOFT_EXPIRED;
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

    getInput(): TokenAmount<T["ChainId"], BtcToken<false>> {
        return toTokenAmount(new BN(this.amount), this.inputToken, this.wrapper.prices);
    }

    /**
     * Returns claimer bounty, acting as a reward for watchtowers to claim the swap automatically
     */
    getClaimerBounty(): TokenAmount<T["ChainId"], SCToken<T["ChainId"]>> {
        return toTokenAmount(this.data.getClaimerBounty(), this.wrapper.tokens[this.wrapper.contract.getNativeCurrencyAddress()], this.wrapper.prices);
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
        if(this.state!==FromBTCSwapState.CLAIM_COMMITED && this.state!==FromBTCSwapState.EXPIRED) throw new Error("Must be in COMMITED state!");

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
        if(
            (this.state as FromBTCSwapState)!==FromBTCSwapState.CLAIM_CLAIMED &&
            (this.state as FromBTCSwapState)!==FromBTCSwapState.FAILED
        ) {
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
    //// Commit

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in a PTLC
     *
     * @param signer Signer to sign the transactions with, must be the same as used in the initialization
     * @param abortSignal Abort signal to stop waiting for the transaction confirmation and abort
     * @param skipChecks Skip checks like making sure init signature is still valid and swap wasn't commited yet
     *  (this is handled when swap is created (quoted), if you commit right after quoting, you can use skipChecks=true)
     * @throws {Error} If invalid signer is provided that doesn't match the swap data
     */
    async commit(signer: T["Signer"], abortSignal?: AbortSignal, skipChecks?: boolean): Promise<string> {
        this.checkSigner(signer);
        const result = await this.wrapper.contract.sendAndConfirm(
            signer, await this.txsCommit(skipChecks), true, abortSignal
        );

        this.commitTxId = result[0];
        if(this.state===FromBTCSwapState.PR_CREATED || this.state===FromBTCSwapState.QUOTE_SOFT_EXPIRED) {
            await this._saveAndEmit(FromBTCSwapState.CLAIM_COMMITED);
        }
        return result[0];
    }

    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCSwapState.CLAIM_COMMITED || this.state===FromBTCSwapState.CLAIM_CLAIMED) return Promise.resolve();
        if(this.state!==FromBTCSwapState.PR_CREATED && this.state!==FromBTCSwapState.QUOTE_SOFT_EXPIRED) throw new Error("Invalid state");

        const abortController = extendAbortController(abortSignal);
        const result = await Promise.race([
            this.watchdogWaitTillCommited(abortController.signal),
            this.waitTillState(FromBTCSwapState.CLAIM_COMMITED, "gte", abortController.signal).then(() => 0)
        ]);
        abortController.abort();

        if(result===0) this.logger.debug("waitTillCommited(): Resolved from state changed");
        if(result===true) this.logger.debug("waitTillCommited(): Resolved from watchdog - commited");
        if(result===false) {
            this.logger.debug("waitTillCommited(): Resolved from watchdog - signature expired");
            if(this.state===FromBTCSwapState.PR_CREATED || this.state===FromBTCSwapState.QUOTE_SOFT_EXPIRED) {
                await this._saveAndEmit(FromBTCSwapState.QUOTE_EXPIRED);
            }
            return;
        }

        if(this.state===FromBTCSwapState.PR_CREATED || this.state===FromBTCSwapState.QUOTE_SOFT_EXPIRED) {
            await this._saveAndEmit(FromBTCSwapState.CLAIM_COMMITED);
        }
    }


    //////////////////////////////
    //// Claim

    /**
     * Returns transactions required to claim the swap on-chain (and possibly also sync the bitcoin light client)
     *  after a bitcoin transaction was sent and confirmed
     *
     * @throws {Error} If the swap is in invalid state (must be BTC_TX_CONFIRMED)
     */
    async txsClaim(signer?: T["Signer"]): Promise<T["TX"][]> {
        if(!this.canClaim()) throw new Error("Must be in BTC_TX_CONFIRMED state!");

        const tx = await this.wrapper.btcRpc.getTransaction(this.txId);

        return await this.wrapper.contract.txsClaimWithTxData(signer ?? this.getInitiator(), this.data, tx.blockheight, {
            blockhash: tx.blockhash,
            confirmations: this.data.getConfirmations(),
            txid: tx.txid,
            hex: tx.hex
        }, this.vout, null, this.wrapper.synchronizer, true);
    }

    /**
     * Claims and finishes the swap
     *
     * @param signer Signer to sign the transactions with, can also be different to the initializer
     * @param abortSignal Abort signal to stop waiting for transaction confirmation
     */
    async claim(signer: T["Signer"], abortSignal?: AbortSignal): Promise<string> {
        let txIds: string[];
        try {
            txIds = await this.wrapper.contract.sendAndConfirm(
                signer, await this.txsClaim(signer), true, abortSignal
            );
        } catch (e) {
            this.logger.info("claim(): Failed to claim ourselves, checking swap claim state...");
            if(this.state===FromBTCSwapState.CLAIM_CLAIMED) {
                this.logger.info("claim(): Transaction state is CLAIM_CLAIMED, swap was successfully claimed by the watchtower");
                return this.claimTxId;
            }
            if((await this.wrapper.contract.getCommitStatus(this.getInitiator(), this.data))===SwapCommitStatus.PAID) {
                this.logger.info("claim(): Transaction commit status is PAID, swap was successfully claimed by the watchtower");
                await this._saveAndEmit(FromBTCSwapState.CLAIM_CLAIMED);
                return null;
            }
            throw e;
        }

        this.claimTxId = txIds[0];
        await this._saveAndEmit(FromBTCSwapState.CLAIM_CLAIMED);
        return txIds[0];
    }

    /**
     * Waits till the swap is successfully claimed
     *
     * @param abortSignal AbortSignal
     * @throws {Error} If swap is in invalid state (must be BTC_TX_CONFIRMED)
     * @throws {Error} If the LP refunded sooner than we were able to claim
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        if(this.state===FromBTCSwapState.CLAIM_CLAIMED) return Promise.resolve();
        if(this.state!==FromBTCSwapState.BTC_TX_CONFIRMED) throw new Error("Invalid state (not BTC_TX_CONFIRMED)");

        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => abortController.abort(abortSignal.reason));
        const res = await Promise.race([
            this.watchdogWaitTillResult(abortController.signal),
            this.waitTillState(FromBTCSwapState.CLAIM_CLAIMED, "eq", abortController.signal).then(() => 0),
            this.waitTillState(FromBTCSwapState.FAILED, "eq", abortController.signal).then(() => 1),
        ]);
        abortController.abort();

        if(res===0) {
            this.logger.debug("waitTillClaimed(): Resolved from state change (CLAIM_CLAIMED)");
            return;
        }
        if(res===1) {
            this.logger.debug("waitTillClaimed(): Resolved from state change (FAILED)");
            throw new Error("Offerer refunded during claiming");
        }
        this.logger.debug("waitTillClaimed(): Resolved from watchdog");

        if(res===SwapCommitStatus.PAID) {
            if((this.state as FromBTCSwapState)!==FromBTCSwapState.CLAIM_CLAIMED) await this._saveAndEmit(FromBTCSwapState.CLAIM_CLAIMED);
        }
        if(res===SwapCommitStatus.NOT_COMMITED || res===SwapCommitStatus.EXPIRED) {
            if(
                (this.state as FromBTCSwapState)!==FromBTCSwapState.CLAIM_CLAIMED &&
                (this.state as FromBTCSwapState)!==FromBTCSwapState.FAILED
            ) await this._saveAndEmit(FromBTCSwapState.FAILED);
        }
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