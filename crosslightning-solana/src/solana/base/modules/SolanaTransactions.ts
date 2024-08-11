import {
    Commitment, ComputeBudgetInstruction,
    ComputeBudgetProgram, Keypair,
    SendOptions, Signer, Transaction,
    TransactionExpiredBlockheightExceededError, TransactionInstruction
} from "@solana/web3.js";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {SolanaModule} from "../SolanaModule";
import * as bs58 from "bs58";
import {SolanaFees} from "./SolanaFees";

export type SolanaTx = {tx: Transaction, signers: Signer[]};

export class SolanaTransactions extends SolanaModule {

    private cbkBeforeTxSigned: (tx: SolanaTx) => Promise<void>;
    private cbkSendTransaction: (tx: Buffer, options?: SendOptions) => Promise<string>;

    ///////////////////
    //// Transactions
    public confirmTransaction(rawTx: Buffer, signature: string, blockhash: string, lastValidBlockHeight: number, abortSignal?: AbortSignal, commitment?: Commitment) {
        return new Promise<void>((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.provider.connection.getSignatureStatus(signature).then(status => {
                    if(status!=null && status.value!=null && status.value.confirmationStatus===commitment) {
                        console.log("SolanaSwapProgram: confirmTransaction(): Confirmed from watchdog!");
                        if(status.value.err!=null) {
                            reject(new Error("Transaction reverted!"));
                        } else {
                            resolve();
                        }
                        abortController.abort();
                    }
                }).catch(e => console.error(e));
                this.sendRawTransaction(rawTx, {skipPreflight: true}).then(result => {
                    console.log("SolanaSwapProgram: resendTransaction(): ", result);
                }).catch(e => console.error("SolanaSwapProgram: resendTransaction(): ", e));
            }, this.retryPolicy?.transactionResendInterval || 3000);
            abortController.signal.addEventListener("abort", () => clearInterval(intervalWatchdog));

            this.provider.connection.confirmTransaction({
                signature: signature,
                blockhash: blockhash,
                lastValidBlockHeight: lastValidBlockHeight,
                abortSignal: abortController.signal
            }, commitment).then((result) => {
                console.log("SolanaSwapProgram: confirmTransaction(): Confirmed from ws!");
                if(result.value.err!=null) {
                    reject(new Error("Transaction reverted!"));
                } else {
                    resolve();
                }
                abortController.abort();
            }).catch((err) => {
                console.log("SolanaSwapProgram: confirmTransaction(): Rejected from ws!");
                const wasAborted = abortController.signal.aborted;
                abortController.abort();
                if(!wasAborted) {
                    //Check if it really isn't confirmed
                    console.log("SolanaSwapProgram: confirmTransaction(): Running ultimate check!");
                    tryWithRetries(() => this.provider.connection.getSignatureStatus(signature)).then(status => {
                        if(status!=null && status.value!=null && status.value.confirmationStatus===commitment) {
                            console.log("SolanaSwapProgram: confirmTransaction(): Confirmed on ultimate check!");
                            if(status.value.err!=null) {
                                reject(new Error("Transaction reverted!"));
                            } else {
                                resolve();
                            }
                            return;
                        }
                        if(err instanceof TransactionExpiredBlockheightExceededError || err.toString().startsWith("TransactionExpiredBlockheightExceededError")) {
                            reject(new Error("Transaction expired before confirmation, please try again!"));
                        } else {
                            reject(err);
                        }
                    }).catch(e => reject(e));
                    return;
                }
                reject(err);
            });

            if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
                abortController.abort();
                reject("Aborted");
            });
        });

    }

    public async sendRawTransaction(data: Buffer, options?: SendOptions): Promise<string> {
        let result: string = null;
        if(this.cbkSendTransaction!=null) result = await this.cbkSendTransaction(data, options);
        if(result==null) result = await this.solanaFeeEstimator.submitTx(data, options);
        if(result==null) result = await this.provider.connection.sendRawTransaction(data, options);
        return result;
    }

    public async sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        let latestBlockData: {blockhash: string, lastValidBlockHeight: number} = null;

        for(let tx of txs) {
            if(tx.tx.recentBlockhash==null) {
                if(latestBlockData==null) latestBlockData = await tryWithRetries(() => this.provider.connection.getLatestBlockhash("confirmed"), this.retryPolicy);
                tx.tx.recentBlockhash = latestBlockData.blockhash;
                tx.tx.lastValidBlockHeight = latestBlockData.lastValidBlockHeight;
            }

            if(this.provider.signer==null && tx.tx.signatures.length===0) {
                const foundIx = tx.tx.instructions.find(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ComputeBudgetInstruction.decodeInstructionType(ix)==="SetComputeUnitPrice")
                if(foundIx==null) tx.tx.instructions.splice(tx.tx.instructions.length-1, 0, ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}));
            }
            tx.tx.feePayer = this.provider.publicKey;
            if(this.cbkBeforeTxSigned!=null) await this.cbkBeforeTxSigned(tx);
            if(tx.signers!=null && tx.signers.length>0) for(let signer of tx.signers) tx.tx.sign(signer);
        }

        const signedTxs = await this.provider.wallet.signAllTransactions(txs.map(e => e.tx));

        console.trace("[SolanaSwapProgram]: sendAndConfirm");

        const options = {
            skipPreflight: true
        };

        const signatures: string[] = [];
        if(parallel) {
            const promises = [];
            for(let i=0;i<signedTxs.length;i++) {
                const tx = signedTxs[i];
                const unsignedTx = txs[i];
                console.log("Send TX: ", tx);
                if(onBeforePublish!=null) await onBeforePublish(bs58.encode(tx.signature), await this.serializeTx({
                    tx,
                    signers: unsignedTx.signers
                }));
                const serializedTx = tx.serialize();
                const txResult = await tryWithRetries(() => this.sendRawTransaction(serializedTx, options), this.retryPolicy);
                console.log("Send signed TX: ", txResult);
                if(waitForConfirmation) {
                    promises.push(this.confirmTransaction(
                        serializedTx,
                        txResult,
                        tx.recentBlockhash,
                        unsignedTx.tx.lastValidBlockHeight || latestBlockData?.lastValidBlockHeight,
                        abortSignal,
                        "confirmed"
                    ));
                }
                signatures.push(txResult);
            }
            if(promises.length>0) {
                await Promise.all(promises);
            }
        } else {
            let lastTx;
            let lastUnsignedTx;
            if(!waitForConfirmation) {
                lastTx = signedTxs.pop();
                lastUnsignedTx = txs.pop();
            }
            for(let i=0;i<signedTxs.length;i++) {
                const tx = signedTxs[i];
                const unsignedTx = txs[i];
                console.log("Send TX: ", tx);
                if(onBeforePublish!=null) await onBeforePublish(bs58.encode(tx.signature), await this.serializeTx({
                    tx,
                    signers: unsignedTx.signers
                }));
                const serializedTx = tx.serialize();
                const txResult = await tryWithRetries(() => this.sendRawTransaction(serializedTx, options), this.retryPolicy);
                console.log("Send signed TX: ", txResult);
                await this.confirmTransaction(
                    serializedTx,
                    txResult,
                    tx.recentBlockhash,
                    unsignedTx.tx.lastValidBlockHeight || latestBlockData?.lastValidBlockHeight,
                    abortSignal,
                    "confirmed"
                );
                signatures.push(txResult);
            }
            if(lastTx!=null) {
                console.log("Send TX: ", lastTx);
                if(onBeforePublish!=null) await onBeforePublish(bs58.encode(lastTx.signature), await this.serializeTx({
                    tx: lastTx,
                    signers: lastUnsignedTx.signers
                }));
                const txResult = await tryWithRetries(() => this.sendRawTransaction(lastTx.serialize(), options), this.retryPolicy);
                console.log("Send signed TX: ", txResult);
                signatures.push(txResult);
            }
        }

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
            if(currentBlockheight>parsedTx.tx.lastValidBlockHeight) {
                return "not_found";
            } else {
                return "pending";
            }
        }
        if(txReceipt.meta.err) return "reverted";
        return "success";
    }

    public async getTxIdStatus(txId: string): Promise<"pending" | "success" | "not_found" | "reverted"> {
        const txReceipt = await this.provider.connection.getTransaction(txId, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(txReceipt==null) return "not_found";
        if(txReceipt.meta.err) return "reverted";
        return "success";
    }

    public createTransaction(
        instructions: TransactionInstruction[],
        computeBudget: number,
        feeRate?: string,
        signers?: Signer[]
    ): SolanaTx {
        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaFees.applyFeeRate(tx, computeBudget, feeRate);
        instructions.forEach(ix => tx.add(ix));
        SolanaFees.applyFeeRateEnd(tx, computeBudget, feeRate);

        return {
            tx,
            signers: signers==null ? [] : signers
        };
    }

    public onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void {
    }
    public offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean {
        return true;
    }

    public onBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): void {
        console.trace("[SolanaSwapProgram]: onBeforeTxSigned");
        this.cbkBeforeTxSigned = callback;
    }
    public offBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): boolean {
        console.trace("[SolanaSwapProgram]: offBeforeTxSigned");
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