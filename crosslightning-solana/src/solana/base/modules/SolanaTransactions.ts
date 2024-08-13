import {
    ComputeBudgetInstruction,
    ComputeBudgetProgram, Finality, Keypair, RpcResponseAndContext,
    SendOptions, SignatureResult, Signer, Transaction,
    TransactionExpiredBlockheightExceededError
} from "@solana/web3.js";
import {SolanaModule} from "../SolanaModule";
import * as bs58 from "bs58";
import {tryWithRetries} from "../../../utils/Utils";

export type SolanaTx = {tx: Transaction, signers: Signer[]};

export class SolanaTransactions extends SolanaModule {

    private cbkBeforeTxSigned: (tx: SolanaTx) => Promise<void>;
    private cbkSendTransaction: (tx: Buffer, options?: SendOptions) => Promise<string>;

    private async sendRawTransaction(data: Buffer, options?: SendOptions): Promise<string> {
        let result: string = null;
        if(this.cbkSendTransaction!=null) result = await this.cbkSendTransaction(data, options);
        if(result==null) result = await this.root.Fees.submitTx(data, options);
        if(result==null) result = await this.provider.connection.sendRawTransaction(data, options);
        this.logger.debug("sendRawTransaction(): tx sent, signature: "+result);
        return result;
    }

    private txConfirmationAndResendWatchdog(rawTx: Buffer, signature: string, finality?: Finality, abortSignal?: AbortSignal): Promise<void> {
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
                if(status==null || status==="pending" || status==="not_found") return;
                if(status==="success") {
                    this.logger.info("txConfirmFromWebsocket(): transaction confirmed from HTTP polling, signature: "+signature);
                    resolve();
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

    private async txConfirmFromWebsocket(
        signature: string,
        blockhash: string,
        lastValidBlockHeight: number,
        finality?: Finality,
        abortSignal?: AbortSignal
    ): Promise<void> {
        let result: RpcResponseAndContext<SignatureResult>;
        try {
            result = await this.provider.connection.confirmTransaction({
                signature: signature,
                blockhash: blockhash,
                lastValidBlockHeight: lastValidBlockHeight,
                abortSignal
            }, finality);
            this.logger.info("txConfirmFromWebsocket(): transaction confirmed from WS, signature: "+signature);
        } catch (err) {
            if(abortSignal!=null && abortSignal.aborted) throw err;
            this.logger.debug("txConfirmFromWebsocket(): transaction rejected from WS, running ultimate check, signature: "+signature);
            const status = await tryWithRetries(
                () => this.getTxIdStatus(signature, finality)
            );
            this.logger.info("txConfirmFromWebsocket(): transaction status: "+status+" signature: "+signature);
            if(status==="success") return;
            if(status==="reverted") throw new Error("Transaction reverted!");
            if(err instanceof TransactionExpiredBlockheightExceededError || err.toString().startsWith("TransactionExpiredBlockheightExceededError")) {
                throw new Error("Transaction expired before confirmation, please try again!");
            } else {
                throw err;
            }
        }
        if(result.value.err!=null) throw new Error("Transaction reverted!");
    }

    private async confirmTransaction(solanaTx: SolanaTx, abortSignal?: AbortSignal, finality?: Finality) {
        const abortController = new AbortController();
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
            abortController.abort();
        });

        const rawTx = solanaTx.tx.serialize();
        const signature = bs58.encode(solanaTx.tx.signature);

        try {
            await Promise.race([
                this.txConfirmationAndResendWatchdog(rawTx, signature, finality, abortController.signal),
                this.txConfirmFromWebsocket(signature, solanaTx.tx.recentBlockhash, solanaTx.tx.lastValidBlockHeight, finality, abortController.signal)
            ]);
        } catch (e) {
            abortController.abort(e);
            throw e;
        }

        this.logger.info("confirmTransaction(): transaction confirmed, signature: "+signature);

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
                        " blockhash: "+latestBlockData.blockhash);
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

    private async sendSignedTransaction(solTx: SolanaTx, options?: SendOptions, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string> {
        if(onBeforePublish!=null) await onBeforePublish(bs58.encode(solTx.tx.signature), await this.serializeTx(solTx));
        const serializedTx = solTx.tx.serialize();
        this.logger.debug("sendSignedTransaction(): sending transaction: "+serializedTx.toString("hex")+
            " signature: "+bs58.encode(solTx.tx.signature));
        const txResult = await tryWithRetries(() => this.sendRawTransaction(serializedTx, options), this.retryPolicy);
        this.logger.info("sendSignedTransaction(): tx sent, signature: "+txResult);
        return txResult;
    }

    public async sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        await this.prepareTransactions(txs)
        const signedTxs = await this.provider.wallet.signAllTransactions(txs.map(e => e.tx));
        signedTxs.forEach((tx, index) => txs[index].tx = tx);

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

    public serializeTx(tx: SolanaTx): Promise<string> {
        return Promise.resolve(JSON.stringify({
            tx: tx.tx.serialize().toString("hex"),
            signers: tx.signers.map(e => Buffer.from(e.secretKey).toString("hex")),
            lastValidBlockheight: tx.tx.lastValidBlockHeight
        }));
    }

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

    public async getTxIdStatus(txId: string, finality?: Finality): Promise<"pending" | "success" | "not_found" | "reverted"> {
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