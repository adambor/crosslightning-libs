import {
    Commitment, ComputeBudgetInstruction, ComputeBudgetProgram, Keypair,
    ParsedAccountsModeBlockResponse,
    PublicKey, SendOptions,
    Signer, SystemProgram, Transaction,
    TransactionExpiredBlockheightExceededError
} from "@solana/web3.js";
import {AnchorProvider} from "@coral-xyz/anchor";
import {
    Account, createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction, createTransferInstruction,
    getAccount, getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    TokenAccountNotFoundError
} from "@solana/spl-token";
import * as BN from "bn.js";
import {createHash} from "crypto";
import {sign} from "tweetnacl";
import {tryWithRetries} from "../utils/RetryUtils";
import {SolanaFeeEstimator} from "../utils/SolanaFeeEstimator";
import * as bs58 from "bs58";

export type SolanaTx = {tx: Transaction, signers: Signer[]};

export type SolanaRetryPolicy = {
    maxRetries?: number,
    delay?: number,
    exponential?: boolean,
    transactionResendInterval?: number
}

export class SolanaBase {

    protected static readonly BaseCUCosts = {
        WRAP_SOL: 10000,
        ATA_CLOSE: 10000,
        ATA_INIT: 40000,
        TRANSFER: 50000
    };

    public readonly WSOL_ADDRESS = new PublicKey("So11111111111111111111111111111111111111112");
    public readonly SPL_ATA_RENT_EXEMPT = 2039280;

    public readonly SLOT_TIME = 400;
    public readonly TX_SLOT_VALIDITY = 151;

    public readonly SLOT_CACHE_SLOTS = 12;
    public readonly SLOT_CACHE_TIME = this.SLOT_CACHE_SLOTS*this.SLOT_TIME;

    private blockCache: Map<number, Promise<ParsedAccountsModeBlockResponse>> = new Map<number, Promise<ParsedAccountsModeBlockResponse>>();
    private slotCache: {
        [key in Commitment]?: {
            slot: Promise<number>,
            timestamp: number
        }
    } = {};

    private cbkBeforeTxSigned: (tx: SolanaTx) => Promise<void>;
    private cbkSendTransaction: (tx: Buffer, options?: SendOptions) => Promise<string>;

    protected readonly provider: AnchorProvider & {signer?: Signer};
    protected readonly retryPolicy: SolanaRetryPolicy;

    readonly solanaFeeEstimator: SolanaFeeEstimator;

    constructor(
        provider: AnchorProvider & {signer?: Signer},
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFeeEstimator = new SolanaFeeEstimator(provider.connection)
    ) {
        this.provider = provider;
        this.solanaFeeEstimator = solanaFeeEstimator;
        this.retryPolicy = retryPolicy;
    }


    ///////////////////
    //// Blocks
    protected async findLatestParsedBlock(commitment: Commitment): Promise<{
        block: ParsedAccountsModeBlockResponse,
        slot: number
    }> {
        let slot = await this.getCachedSlot(commitment);

        let error;
        for(let i=0;i<10;i++) {
            try {
                return {
                    block: await this.getParsedBlock(slot),
                    slot
                }
            } catch (e) {
                console.error(e);
                if(e.toString().startsWith("SolanaJSONRPCError: failed to get block: Block not available for slot")) {
                    slot--;
                    error = e;
                } else {
                    throw e;
                }
            }
        }

        throw error;
    }

    private fetchAndSaveParsedBlock(slot: number): Promise<ParsedAccountsModeBlockResponse> {
        const blockCacheData = this.provider.connection.getParsedBlock(slot, {
            transactionDetails: "none",
            commitment: "confirmed",
            rewards: false
        });
        this.blockCache.set(slot, blockCacheData);
        blockCacheData.catch(e => {
            if(this.blockCache.get(slot)==blockCacheData) this.blockCache.delete(slot);
        });
        return blockCacheData;
    }

    //Parsed block caching
    protected async getParsedBlock(slot: number): Promise<ParsedAccountsModeBlockResponse> {
        let blockCacheData = this.blockCache.get(slot);
        if(blockCacheData==null) {
            blockCacheData = this.fetchAndSaveParsedBlock(slot);
        }
        return await blockCacheData;
    }


    ///////////////////
    //// Slots
    private fetchAndSaveSlot(commitment: Commitment): {slot: Promise<number>, timestamp: number} {
        const slotPromise = this.provider.connection.getSlot(commitment);
        const timestamp = Date.now();
        this.slotCache[commitment] = {
            slot: slotPromise,
            timestamp
        }
        slotPromise.catch(e => {
            if(this.slotCache[commitment]!=null && this.slotCache[commitment].slot===slotPromise) delete this.slotCache[commitment];
        })
        return {
            slot: slotPromise,
            timestamp
        }
    }

    protected async getCachedSlotAndTimestamp(commitment: Commitment): Promise<{
        slot: number,
        timestamp: number
    }> {
        let cachedSlotData = this.slotCache[commitment];

        if(cachedSlotData==null || Date.now()-cachedSlotData.timestamp>this.SLOT_CACHE_TIME) {
            cachedSlotData = this.fetchAndSaveSlot(commitment);
        }

        return {
            slot: await cachedSlotData.slot,
            timestamp: cachedSlotData.timestamp
        };
    }

    protected async getCachedSlot(commitment: Commitment): Promise<number> {
        let cachedSlotData = this.slotCache[commitment];

        if(cachedSlotData!=null && Date.now()-cachedSlotData.timestamp<this.SLOT_CACHE_TIME) {
            return (await cachedSlotData.slot) + Math.floor((Date.now()-cachedSlotData.timestamp)/this.SLOT_TIME);
        }

        cachedSlotData = this.fetchAndSaveSlot(commitment);

        return await cachedSlotData.slot;
    }


    ///////////////////
    //// Tokens
    protected getATAOrNull(ata: PublicKey): Promise<Account> {
        return getAccount(this.provider.connection, ata).catch(e => {
            if(e instanceof TokenAccountNotFoundError) {
                return null;
            }
            throw e;
        });
    }

    getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(this.SPL_ATA_RENT_EXEMPT));
    }

    protected async getTokenBalance(token: PublicKey) {
        const ata: PublicKey = getAssociatedTokenAddressSync(token, this.provider.publicKey);
        const [ataAccount, balance] = await Promise.all<[Promise<Account>, Promise<number>]>([
            this.getATAOrNull(ata),
            (token!=null && token.equals(this.WSOL_ADDRESS)) ? this.provider.connection.getBalance(this.provider.publicKey) : Promise.resolve(null)
        ]);

        let ataExists: boolean = ataAccount!=null;
        let sum: BN = new BN(0);
        if(ataExists) {
            sum = sum.add(new BN(ataAccount.amount.toString()));
        }

        if(balance!=null) {
            let balanceLamports: BN = new BN(balance);
            if(!ataExists) balanceLamports = balanceLamports.sub(await this.getATARentExemptLamports());
            if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
        }

        return sum;
    }


    ///////////////////
    //// Data signatures
    getDataSignature(data: Buffer): Promise<string> {
        if(this.provider.signer==null) throw new Error("Unsupported");
        const buff = createHash("sha256").update(data).digest();
        const signature = sign.detached(buff, this.provider.signer.secretKey);

        return Promise.resolve(Buffer.from(signature).toString("hex"));
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        const hash = createHash("sha256").update(data).digest();
        return Promise.resolve(sign.detached.verify(hash, Buffer.from(signature, "hex"), new PublicKey(publicKey).toBuffer()));
    }


    ///////////////////
    //// Transactions
    confirmTransaction(rawTx: Buffer, signature: string, blockhash: string, lastValidBlockHeight: number, abortSignal?: AbortSignal, commitment?: Commitment) {
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

    async sendRawTransaction(data: Buffer, options?: SendOptions): Promise<string> {
        let result: string = null;
        if(this.cbkSendTransaction!=null) result = await this.cbkSendTransaction(data, options);
        if(result==null) result = await this.solanaFeeEstimator.submitTx(data, options);
        if(result==null) result = await this.provider.connection.sendRawTransaction(data, options);
        return result;
    }

    async sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
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

    serializeTx(tx: SolanaTx): Promise<string> {
        return Promise.resolve(JSON.stringify({
            tx: tx.tx.serialize().toString("hex"),
            signers: tx.signers.map(e => Buffer.from(e.secretKey).toString("hex")),
            lastValidBlockheight: tx.tx.lastValidBlockHeight
        }));
    }

    deserializeTx(txData: string): Promise<SolanaTx> {
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

    async getTxStatus(tx: string): Promise<"pending" | "success" | "not_found" | "reverted"> {
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

    async getTxIdStatus(txId: string): Promise<"pending" | "success" | "not_found" | "reverted"> {
        const txReceipt = await this.provider.connection.getTransaction(txId, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(txReceipt==null) return "not_found";
        if(txReceipt.meta.err) return "reverted";
        return "success";

    }

    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void {
    }
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean {
        return true;
    }

    onBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): void {
        console.trace("[SolanaSwapProgram]: onBeforeTxSigned");
        this.cbkBeforeTxSigned = callback;
    }
    offBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): boolean {
        console.trace("[SolanaSwapProgram]: offBeforeTxSigned");
        this.cbkBeforeTxSigned = null;
        return true;
    }

    onSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): void {
        this.cbkSendTransaction = callback;
    }
    offSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): boolean {
        this.cbkSendTransaction = null;
        return true;
    }


    ///////////////////
    //// Utils
    getNativeCurrencyAddress(): PublicKey {
        return this.WSOL_ADDRESS;
    }

    getAddress(): string {
        return this.provider.publicKey.toBase58();
    }

    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

    toTokenAddress(address: string): PublicKey {
        return new PublicKey(address);
    }


    ///////////////////
    //// Fees
    async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate(mutableAccounts);
    }

    static getTransactionNonCUIxs(tx: Transaction): number {
        let counter = 0;
        for(let ix of tx.instructions) {
            if(!ix.programId.equals(ComputeBudgetProgram.programId)) counter++;
        }
        return counter;
    }

    //Has to be called after feePayer is set for the tx
    static applyFeeRate(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        if(computeBudget!=null) tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget,
        }));

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {

        } else {
            let fee: bigint = BigInt(arr[0]);
            if(arr.length>1) {
                const staticFee = BigInt(arr[1])*BigInt(1000000)/BigInt(computeBudget || (200000*SolanaBase.getTransactionNonCUIxs(tx)));
                fee += staticFee;
            }
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            }));
        }
    }

    static applyFeeRateEnd(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {
            const cuPrice = BigInt(arr[0]);
            const staticFee = BigInt(arr[1]);
            const bribeAddress = new PublicKey(arr[2]);
            tx.add(SystemProgram.transfer({
                fromPubkey: tx.feePayer,
                toPubkey: bribeAddress,
                lamports: staticFee + ((BigInt(computeBudget || (200000*(SolanaBase.getTransactionNonCUIxs(tx)+1)))*cuPrice)/BigInt(1000000))
            }));
            return;
        }
    }

    static getFeePerCU(feeRate: string): string {
        if(feeRate==null) return null;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        const arr = feeRate.split(";");
        return arr.length>1 ? arr[0] : feeRate;
    }

    static getStaticFee(feeRate: string): string {
        if(feeRate==null) return null;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        const arr = feeRate.split(";");
        return arr.length>2 ? arr[1] : "0";
    }


    ///////////////////
    //// Transfers
    async transfer(token: PublicKey, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress, feeRate);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    async txsTransfer(token: PublicKey, amount: BN, dstAddress: string, feeRate?: string): Promise<SolanaTx[]> {
        const recipient = new PublicKey(dstAddress);

        let computeBudget = SolanaBase.BaseCUCosts.TRANSFER;

        if(this.WSOL_ADDRESS.equals(token)) {
            const wsolAta = getAssociatedTokenAddressSync(token, this.provider.publicKey, false);
            const account = await tryWithRetries<Account>(() => this.getATAOrNull(wsolAta), this.retryPolicy);

            const tx = new Transaction();
            tx.feePayer = this.provider.publicKey;

            if(account!=null) {
                feeRate = feeRate || await this.getFeeRate([this.provider.publicKey, recipient, wsolAta]);
                computeBudget += SolanaBase.BaseCUCosts.ATA_CLOSE;
                SolanaBase.applyFeeRate(tx, computeBudget, feeRate);
                //Unwrap
                tx.add(
                    createCloseAccountInstruction(wsolAta, this.provider.publicKey, this.provider.publicKey)
                );
            } else {
                feeRate = feeRate || await this.getFeeRate([this.provider.publicKey, recipient]);
                SolanaBase.applyFeeRate(tx, computeBudget, feeRate);
            }

            tx.add(
                SystemProgram.transfer({
                    fromPubkey: this.provider.publicKey,
                    toPubkey: recipient,
                    lamports: BigInt(amount.toString(10))
                })
            );

            SolanaBase.applyFeeRateEnd(tx, computeBudget, feeRate);

            return [{
                tx,
                signers: []
            }];
        }

        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);

        if(!PublicKey.isOnCurve(new PublicKey(dstAddress))) {
            throw new Error("Recipient must be a valid public key");
        }

        const dstAta = getAssociatedTokenAddressSync(token, new PublicKey(dstAddress), false);

        feeRate = feeRate || await this.getFeeRate([this.provider.publicKey, ata, dstAta]);

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaBase.applyFeeRate(tx, computeBudget, feeRate);

        const account = await tryWithRetries<Account>(() => this.getATAOrNull(dstAta), this.retryPolicy);
        console.log("Account ATA: ", account);
        if(account==null) {
            tx.add(
                createAssociatedTokenAccountInstruction(this.provider.publicKey, dstAta, new PublicKey(dstAddress), token)
            );
        }

        const ix = createTransferInstruction(ata, dstAta, this.provider.publicKey, BigInt(amount.toString(10)));
        tx.add(ix);

        SolanaBase.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx: tx,
            signers: []
        }];
    }


}