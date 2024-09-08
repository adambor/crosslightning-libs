import {
    ComputeBudgetInstruction,
    ComputeBudgetProgram, Finality, Keypair, RpcResponseAndContext,
    SendOptions, SignatureResult, Signer, Transaction,
    TransactionExpiredBlockheightExceededError
} from "@solana/web3.js";
import {SolanaModule} from "../SolanaModule";
import * as bs58 from "bs58";
import {tryWithRetries} from "../../../utils/Utils";
import {Buffer} from "buffer";

export type SolanaTx = {tx: Transaction, signers: Signer[]};

export class SolanaTransactions extends SolanaModule {

    private cbkBeforeTxSigned: (tx: SolanaTx) => Promise<void>;
    /**
     * Callback for sending transaction, returns not null if it was successfully able to send the transaction, and null
     *  if the transaction should be sent through other means)
     * @private
     */
    private cbkSendTransaction: (tx: Buffer, options?: SendOptions) => Promise<string>;

    /**
     * Sends raw solana transaction, first through the cbkSendTransaction callback (for e.g. sending the transaction
     *  to a different specific RPC), the through the Fees handler (for e.g. Jito transaction) and last through the
     *  underlying provider's Connection instance (the usual way). Only sends the transaction through one channel.
     *
     * @param data
     * @param options
     * @private
     */
    private async sendRawTransaction(data: Buffer, options?: SendOptions): Promise<string> {
        let result: string = null;
        if(this.cbkSendTransaction!=null) result = await this.cbkSendTransaction(data, options);
        if(result==null) result = await this.root.Fees.submitTx(data, options);
        if(result==null) result = await this.provider.connection.sendRawTransaction(data, options);
        // this.logger.debug("sendRawTransaction(): tx sent, signature: "+result);
        return result;
    }

    /**
     * Waits for the transaction to confirm by periodically checking the transaction status over HTTP, also
     *  re-sends the transaction at regular intervals
     *
     * @param solanaTx solana tx to wait for confirmation for
     * @param finality wait for this finality
     * @param abortSignal signal to abort waiting for tx confirmation
     * @private
     */
    private txConfirmationAndResendWatchdog(
        solanaTx: SolanaTx,
        finality?: Finality,
        abortSignal?: AbortSignal
    ): Promise<string> {
        const rawTx = solanaTx.tx.serialize();
        const signature = bs58.encode(solanaTx.tx.signature);
        return new Promise((resolve, reject) => {
            let watchdogInterval: NodeJS.Timer;
            watchdogInterval = setInterval(async () => {
                const result = await this.sendRawTransaction(rawTx, {skipPreflight: true}).catch(
                    e => this.logger.error("txConfirmationAndResendWatchdog(): transaction re-sent error: ", e)
                );
                this.logger.debug("txConfirmationAndResendWatchdog(): transaction re-sent: "+result);

                const status = await this.getTxIdStatus(signature, finality).catch(
                    e => this.logger.error("txConfirmationAndResendWatchdog(): get tx id status error: ", e)
                );
                if(status==null || status==="not_found") return;
                if(status==="success") {
                    this.logger.info("txConfirmationAndResendWatchdog(): transaction confirmed from HTTP polling, signature: "+signature);
                    resolve(signature);
                }
                if(status==="reverted") reject(new Error("Transaction reverted!"));
                clearInterval(watchdogInterval);
            }, this.retryPolicy?.transactionResendInterval || 3000);

            if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
                clearInterval(watchdogInterval);
                reject(abortSignal.reason);
            });
        })
    }

    /**
     * Waits for the transaction to confirm from WS, sometimes the WS rejects even though the transaction was confirmed
     *  this therefore also runs an ultimate check on the transaction in case the WS handler rejects, checking if it
     *  really was expired
     *
     * @param solanaTx solana tx to wait for confirmation for
     * @param finality wait for this finality
     * @param abortSignal signal to abort waiting for tx confirmation
     * @private
     */
    private async txConfirmFromWebsocket(
        solanaTx: SolanaTx,
        finality?: Finality,
        abortSignal?: AbortSignal
    ): Promise<string> {
        const signature = bs58.encode(solanaTx.tx.signature);

        let result: RpcResponseAndContext<SignatureResult>;
        try {
            result = await this.provider.connection.confirmTransaction({
                signature: signature,
                blockhash: solanaTx.tx.recentBlockhash,
                lastValidBlockHeight: solanaTx.tx.lastValidBlockHeight,
                abortSignal
            }, finality);
            this.logger.info("txConfirmFromWebsocket(): transaction confirmed from WS, signature: "+signature);
        } catch (err) {
            if(abortSignal!=null && abortSignal.aborted) throw err;
            this.logger.debug("txConfirmFromWebsocket(): transaction rejected from WS, running ultimate check, expiry blockheight: "+solanaTx.tx.lastValidBlockHeight+" signature: "+signature+" error: "+err);
            const status = await tryWithRetries(
                () => this.getTxIdStatus(signature, finality)
            );
            this.logger.info("txConfirmFromWebsocket(): transaction status: "+status+" signature: "+signature);
            if(status==="success") return signature;
            if(status==="reverted") throw new Error("Transaction reverted!");
            if(err instanceof TransactionExpiredBlockheightExceededError || err.toString().startsWith("TransactionExpiredBlockheightExceededError")) {
                throw new Error("Transaction expired before confirmation, please try again!");
            } else {
                throw err;
            }
        }
        if(result.value.err!=null) throw new Error("Transaction reverted!");
        return signature;
    }

    /**
     * Waits for transaction confirmation using WS subscription and occasional HTTP polling, also re-sends
     *  the transaction at regular interval
     *
     * @param solanaTx solana transaction to wait for confirmation for & keep re-sending until it confirms
     * @param abortSignal signal to abort waiting for tx confirmation
     * @param finality wait for specific finality
     * @private
     */
    private async confirmTransaction(solanaTx: SolanaTx, abortSignal?: AbortSignal, finality?: Finality) {
        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
            abortController.abort();
        });

        let txSignature: string;
        try {
            txSignature = await Promise.race([
                this.txConfirmationAndResendWatchdog(solanaTx, finality, abortController.signal),
                this.txConfirmFromWebsocket(solanaTx, finality, abortController.signal)
            ]);
        } catch (e) {
            abortController.abort(e);
            throw e;
        }

        // this.logger.info("confirmTransaction(): transaction confirmed, signature: "+txSignature);

        abortController.abort();
    }

    /**
     * Prepares solana transactions, assigns recentBlockhash if needed, applies Phantom hotfix,
     *  sets feePayer to ourselves, calls beforeTxSigned callback & signs transaction with provided signers array
     *
     * @param txs
     * @private
     */
    private async prepareTransactions(txs: SolanaTx[]): Promise<void> {
        let latestBlockData: {blockhash: string, lastValidBlockHeight: number} = null;

        for(let tx of txs) {
            if(tx.tx.recentBlockhash==null) {
                if(latestBlockData==null) {
                    latestBlockData = await tryWithRetries(
                        () => this.provider.connection.getLatestBlockhash("confirmed"),
                        this.retryPolicy
                    );
                    this.logger.debug("prepareTransactions(): fetched latest block data for transactions," +
                        " blockhash: "+latestBlockData.blockhash+" expiry blockheight: "+latestBlockData.lastValidBlockHeight);
                }
                tx.tx.recentBlockhash = latestBlockData.blockhash;
                tx.tx.lastValidBlockHeight = latestBlockData.lastValidBlockHeight;
            }

            //This is a hotfix for Phantom adding compute unit price instruction on the first position & breaking
            // required instructions order (e.g. btc relay verify needs to be 0th instruction in a tx)
            if(this.provider.signer==null && tx.tx.signatures.length===0) {
                const foundIx = tx.tx.instructions.find(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ComputeBudgetInstruction.decodeInstructionType(ix)==="SetComputeUnitPrice")
                if(foundIx==null) tx.tx.instructions.splice(tx.tx.instructions.length-1, 0, ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}));
            }

            tx.tx.feePayer = this.provider.publicKey;
            if(this.cbkBeforeTxSigned!=null) await this.cbkBeforeTxSigned(tx);
            if(tx.signers!=null && tx.signers.length>0) for(let signer of tx.signers) tx.tx.sign(signer);
        }
    }

    /**
     * Sends out a signed transaction to the RPC
     *
     * @param solTx solana tx to send
     * @param options send options to be passed to the RPC
     * @param onBeforePublish a callback called before every transaction is published
     * @private
     */
    private async sendSignedTransaction(solTx: SolanaTx, options?: SendOptions, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string> {
        if(onBeforePublish!=null) await onBeforePublish(bs58.encode(solTx.tx.signature), await this.serializeTx(solTx));
        const serializedTx = solTx.tx.serialize();
        this.logger.debug("sendSignedTransaction(): sending transaction: "+serializedTx.toString("hex")+
            " signature: "+bs58.encode(solTx.tx.signature));
        const txResult = await tryWithRetries(() => this.sendRawTransaction(serializedTx, options), this.retryPolicy);
        this.logger.info("sendSignedTransaction(): tx sent, signature: "+txResult);
        return txResult;
    }

    /**
     * Prepares (adds recent blockhash if required, applies Phantom hotfix),
     *  signs (all together using signAllTransactions() calls), sends (in parallel or sequentially) &
     *  optionally waits for confirmation of a batch of solana transactions
     *
     * @param txs transactions to send
     * @param waitForConfirmation whether to wait for transaction confirmations (this also makes sure the transactions
     *  are re-sent at regular intervals)
     * @param abortSignal abort signal to abort waiting for transaction confirmations
     * @param parallel whether the send all the transaction at once in parallel or sequentially (such that transactions
     *  are executed in order)
     * @param onBeforePublish a callback called before every transaction is published
     */
    public async sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        await this.prepareTransactions(txs)
        const signedTxs = await this.provider.wallet.signAllTransactions(txs.map(e => e.tx));
        signedTxs.forEach((tx, index) => {
            const solTx = txs[index];
            tx.lastValidBlockHeight = solTx.tx.lastValidBlockHeight;
            solTx.tx = tx
        });

        const options = {
            skipPreflight: true
        };

        this.logger.debug("sendAndConfirm(): sending transactions, count: "+txs.length+
            " waitForConfirmation: "+waitForConfirmation+" parallel: "+parallel);

        const signatures: string[] = [];
        if(parallel) {
            const promises: Promise<void>[] = [];
            for(let solTx of txs) {
                const signature = await this.sendSignedTransaction(solTx, options, onBeforePublish);
                if(waitForConfirmation) promises.push(this.confirmTransaction(solTx, abortSignal, "confirmed"));
                signatures.push(signature);
            }
            if(promises.length>0) await Promise.all(promises);
        } else {
            for(let i=0;i<txs.length;i++) {
                const solTx = txs[i];
                const signature = await this.sendSignedTransaction(solTx, options, onBeforePublish);
                const confirmPromise = this.confirmTransaction(solTx, abortSignal, "confirmed");
                //Don't await the last promise when !waitForConfirmation
                if(i<txs.length-1 || waitForConfirmation) await confirmPromise;
                signatures.push(signature);
            }
        }

        this.logger.info("sendAndConfirm(): sent transactions, count: "+txs.length+
            " waitForConfirmation: "+waitForConfirmation+" parallel: "+parallel);

        return signatures;
    }

    /**
     * Serializes the solana transaction, saves the transaction, signers & last valid blockheight
     *
     * @param tx
     */
    public serializeTx(tx: SolanaTx): Promise<string> {
        return Promise.resolve(JSON.stringify({
            tx: tx.tx.serialize().toString("hex"),
            signers: tx.signers.map(e => Buffer.from(e.secretKey).toString("hex")),
            lastValidBlockheight: tx.tx.lastValidBlockHeight
        }));
    }

    /**
     * Deserializes saved solana transaction, extracting the transaction, signers & last valid blockheight
     *
     * @param txData
     */
    public deserializeTx(txData: string): Promise<SolanaTx> {
        const jsonParsed: {
            tx: string,
            signers: string[],
            lastValidBlockheight: number
        } = JSON.parse(txData);

        const transaction = Transaction.from(Buffer.from(jsonParsed.tx, "hex"));
        transaction.lastValidBlockHeight = jsonParsed.lastValidBlockheight;

        return Promise.resolve({
            tx: transaction,
            signers: jsonParsed.signers.map(e => Keypair.fromSecretKey(Buffer.from(e, "hex"))),
        });
    }

    /**
     * Gets the status of the raw solana transaction, this also checks transaction expiry & can therefore report tx
     *  in "pending" status, however pending status doesn't necessarily mean that the transaction was sent (again,
     *  no mempool on Solana, cannot check that), this function is preferred against getTxIdStatus
     *
     * @param tx
     */
    public async getTxStatus(tx: string): Promise<"pending" | "success" | "not_found" | "reverted"> {
        const parsedTx: SolanaTx = await this.deserializeTx(tx);
        const txReceipt = await this.provider.connection.getTransaction(bs58.encode(parsedTx.tx.signature), {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(txReceipt==null) {
            const currentBlockheight = await this.provider.connection.getBlockHeight("processed");
            if(currentBlockheight>parsedTx.tx.lastValidBlockHeight) return "not_found";
            return "pending";
        }
        if(txReceipt.meta.err) return "reverted";
        return "success";
    }

    /**
     * Gets the status of the solana transaction with a specific txId, this cannot report whether the transaction is
     *  "pending" because Solana has no concept of mempool & only confirmed transactions are accessible
     *
     * @param txId
     * @param finality
     */
    public async getTxIdStatus(txId: string, finality?: Finality): Promise<"success" | "not_found" | "reverted"> {
        const txReceipt = await this.provider.connection.getTransaction(txId, {
            commitment: finality || "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(txReceipt==null) return "not_found";
        if(txReceipt.meta.err) return "reverted";
        return "success";
    }

    public onBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): void {
        this.cbkBeforeTxSigned = callback;
    }

    public offBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): boolean {
        this.cbkBeforeTxSigned = null;
        return true;
    }

    public onSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): void {
        this.cbkSendTransaction = callback;
    }

    public offSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): boolean {
        this.cbkSendTransaction = null;
        return true;
    }
}