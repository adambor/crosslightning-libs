import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, BorshCoder, EventParser, IdlAccounts, IdlEvents, IdlTypes, Program} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    AccountInfo,
    Ed25519Program,
    Keypair, ParsedAccountsModeBlockResponse,
    PublicKey,
    Signer,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import {createHash, randomBytes} from "crypto";
import {sign} from "tweetnacl";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import * as programIdl from "./programIdl.json";
import {IStorageManager, SwapContract, ChainSwapType, TokenAddress, IntermediaryReputationType,
    SwapCommitStatus, SignatureVerificationError, SwapDataVerificationError} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {RelaySynchronizer, StorageObject} from "crosslightning-base/dist";
import {tryWithRetries} from "../../utils/RetryUtils";
import {
    Account,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    createSyncNativeInstruction,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction
} from "@solana/spl-token";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";
import {SwapProgram} from "./programTypes";
import {SolanaBase, SolanaRetryPolicy, SolanaTx} from "../SolanaBase";
import {getLogger} from "./Utils";
import {SolanaProgramBase} from "../SolanaProgramBase";

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const TX_DATA_SEED = "data";

export class StoredDataAccount implements StorageObject {

    accountKey: PublicKey;

    constructor(accountKey: PublicKey);
    constructor(data: any);

    constructor(accountKeyOrData: PublicKey | any) {
        if(accountKeyOrData instanceof PublicKey) {
            this.accountKey = accountKeyOrData;
        } else {
            this.accountKey = new PublicKey(accountKeyOrData.accountKey);
        }
    }

    serialize(): any {
        return {
            accountKey: this.accountKey.toBase58()
        }
    }

}

const SIGNATURE_SLOT_BUFFER = 20;
const SIGNATURE_PREFETCH_DATA_VALIDITY = 5000;

const ESCROW_STATE_RENT_EXEMPT = 2658720;

type SolanaPreFetchVerification = {
    latestSlot?: {
        slot: number,
        timestamp: number
    },
    transactionSlot?: {
        slot: number,
        blockhash: string
    }
};

type SolanaPreFetchData = {
    block: ParsedAccountsModeBlockResponse,
    slot: number,
    timestamp: number
}

const logger = getLogger("SolanaSwapProgram: ");

export class SolanaSwapProgram extends SolanaProgramBase<SwapProgram> implements SwapContract<SolanaSwapData, SolanaTx, SolanaPreFetchData, SolanaPreFetchVerification> {

    private static readonly CUCosts = {
        CLAIM: 25000,
        CLAIM_PAY_OUT: 50000,
        INIT: 90000,
        INIT_PAY_IN: 50000,
        DATA_REMOVE: 50000,
        DATA_CREATE_AND_WRITE: 15000,
        DATA_WRITE: 15000,
        CLAIM_ONCHAIN: 600000,
        CLAIM_ONCHAIN_PAY_OUT: 600000,
        REFUND: 15000,
        REFUND_PAY_OUT: 50000,

        WITHDRAW: 50000,
        DEPOSIT: 50000
    };

    claimWithSecretTimeout: number = 45;
    claimWithTxDataTimeout: number = 120;
    refundTimeout: number = 45;

    readonly claimGracePeriod: number = 10*60;
    readonly refundGracePeriod: number = 10*60;
    readonly authGracePeriod: number = 5*60;

    readonly storage: IStorageManager<StoredDataAccount>;

    readonly btcRelay: SolanaBtcRelay<any>;

    readonly SwapVaultAuthority: PublicKey;
    readonly SwapVault: (tokenAddress: PublicKey) => PublicKey = (tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(VAULT_SEED), tokenAddress.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapUserVault: (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey = (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(USER_VAULT_SEED), publicKey.toBuffer(), tokenAddress.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapEscrowState: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
        [Buffer.from(STATE_SEED), hash],
        this.program.programId
    )[0];

    readonly SwapTxData: (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey = (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(TX_DATA_SEED), reversedTxId, pubkey.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapTxDataAlt: (reversedTxId: Buffer, signer: Signer) => Signer = (reversedTxId: Buffer, signer: Signer) => {
        const buff = createHash("sha256").update(Buffer.concat([signer.secretKey, reversedTxId])).digest();
        return Keypair.fromSeed(buff);
    };

    readonly SwapTxDataAltBuffer: (reversedTxId: Buffer, secret: Buffer) => Signer = (reversedTxId: Buffer, secret: Buffer) => {
        const buff = createHash("sha256").update(Buffer.concat([secret, reversedTxId])).digest();
        return Keypair.fromSeed(buff);
    };

    constructor(
        signer: AnchorProvider & {signer?: Signer},
        btcRelay: SolanaBtcRelay<any>,
        storage: IStorageManager<StoredDataAccount>,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFeeEstimator = btcRelay.solanaFeeEstimator || new SolanaFeeEstimator(signer.connection)
    ) {
        super(signer, programIdl, programAddress, retryPolicy, solanaFeeEstimator);

        this.btcRelay = btcRelay;
        this.storage = storage;

        this.SwapVaultAuthority = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
    }

    async preFetchForInitSignatureVerification(data: SolanaPreFetchData): Promise<SolanaPreFetchVerification> {
        const [latestSlot, txBlock] = await Promise.all([
            this.getCachedSlotAndTimestamp("processed"),
            this.getParsedBlock(data.slot)
        ]);
        return {
            latestSlot,
            transactionSlot: {
                slot: data.slot,
                blockhash: txBlock.blockhash
            }
        }
    }

    async preFetchBlockDataForSignatures(): Promise<SolanaPreFetchData> {
        const latestParsedBlock = await this.findLatestParsedBlock("finalized");
        return {
            block: latestParsedBlock.block,
            slot: latestParsedBlock.slot,
            timestamp: Date.now()
        };
    }

    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer {
        return createHash("sha256").update(Buffer.concat([
            Buffer.from(nonce.toArray("le", 8)),
            Buffer.from(amount.toArray("le", 8)),
            outputScript
        ])).digest();
    }

    private saveDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.saveData(publicKey.toBase58(), new StoredDataAccount(publicKey));
    }

    private removeDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.removeData(publicKey.toBase58());
    }

    /**
     * Returns transactions for closing the specific data account
     *
     * @param publicKey
     */
    async txsCloseDataAccount(publicKey: PublicKey): Promise<SolanaTx[]> {
        const eraseTx = await this.program.methods
            .closeData()
            .accounts({
                signer: this.provider.publicKey,
                data: publicKey
            })
            .transaction();

        eraseTx.feePayer = this.provider.publicKey;

        const feeRate = await this.getFeeRate([this.provider.publicKey, publicKey]);
        SolanaSwapProgram.applyFeeRate(eraseTx, SolanaSwapProgram.CUCosts.DATA_REMOVE, feeRate);
        SolanaSwapProgram.applyFeeRateEnd(eraseTx, SolanaSwapProgram.CUCosts.DATA_REMOVE, feeRate);

        return [{tx: eraseTx, signers: []}];
    }

    /**
     * Sweeps all old data accounts, reclaiming the SOL locked in the PDAs
     */
    async sweepDataAccounts() {
        const closePublicKeys: PublicKey[] = [];
        for(let key in this.storage.data) {
            const publicKey = new PublicKey(this.storage.data[key].accountKey);

            try {
                const fetchedDataAccount: AccountInfo<Buffer> = await this.provider.connection.getAccountInfo(publicKey);
                if(fetchedDataAccount==null) {
                    await this.removeDataAccount(publicKey);
                    continue;
                }
                closePublicKeys.push(publicKey);
            } catch (e) {}
        }

        logger.debug("sweepDataAccounts(): closing old data accounts: ", closePublicKeys);

        let txns: SolanaTx[] = [];
        for(let publicKey of closePublicKeys) {
            txns = txns.concat(await this.txsCloseDataAccount(publicKey));
        }

        const result = await this.sendAndConfirm(txns, true, null, true);

        logger.info("sweepDataAccounts(): old data accounts closed: ", closePublicKeys);

        for(let publicKey of closePublicKeys) {
            await this.removeDataAccount(publicKey);
        }
    }

    async start(): Promise<void> {
        await this.storage.init();
        await this.storage.loadData(StoredDataAccount);
        logger.info("start(): sweeping old unused data accounts");
        await this.sweepDataAccounts();
    }

    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            //Also check that swapData's ATA is correct
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
            if(!swapData.claimerAta.equals(ourAta)) return false;
        }
        return swapData.claimer.equals(this.provider.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.provider.publicKey);
    }

    /**
     * Returns provider's balance in the LP vault for specific token
     * @param token
     * @private
     */
    private async getVaultBalance(token: PublicKey): Promise<BN> {
        const tokenAccount: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(
            this.SwapUserVault(this.provider.publicKey, token)
        );
        if(tokenAccount==null) return null;
        const balance = new BN(tokenAccount.amount.toString(10));
        logger.debug("getVaultBalance(): vault balance, token: "+token.toBase58()+" balance: "+balance.toString(10));
        return balance;
    }

    async getBalance(token: PublicKey, inContract: boolean): Promise<BN> {
        if(inContract) return await this.getIntermediaryBalance(this.provider.publicKey.toString(), token);

        let balance = await this.getTokenBalance(token);
        if(token.equals(this.WSOL_ADDRESS)) {
            const feeCosts = new BN(5000).add(await this.getCommitFee(null));
            balance = BN.max(balance.sub(feeCosts), new BN(0));
        }
        logger.debug("getBalance(): token balance, token: "+token.toBase58()+" balance: "+balance.toString(10));
        return balance;
    }

    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        const escrowState: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            if(data.correctPDA(escrowState)) {
                if(this.areWeOfferer(data) && this.isExpired(data)) return SwapCommitStatus.REFUNDABLE;
                return SwapCommitStatus.COMMITED;
            }

            if(this.areWeOfferer(data) && this.isExpired(data)) return SwapCommitStatus.EXPIRED;
            return SwapCommitStatus.NOT_COMMITED;
        }

        //Check if paid or what
        const status = await this.findInEvents(escrowStateKey, async (event) => {
            if(event.name==="ClaimEvent") {
                const eventData: IdlEvents<SwapProgram>["ClaimEvent"] = event.data as any;
                if(!eventData.sequence.eq(data.sequence)) return null;
                return SwapCommitStatus.PAID;
            }
            if(event.name==="RefundEvent") {
                const eventData: IdlEvents<SwapProgram>["RefundEvent"] = event.data as any;
                if(!eventData.sequence.eq(data.sequence)) return null;
                if(this.isExpired(data)) return SwapCommitStatus.EXPIRED;
                return SwapCommitStatus.NOT_COMMITED;
            }
        });
        if(status!=null) return status;

        if(this.isExpired(data)) {
            return SwapCommitStatus.EXPIRED;
        }
        return SwapCommitStatus.NOT_COMMITED;
    }

    async getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(paymentHash, "hex"));
        const abortController = new AbortController();

        //Start fetching events before checking escrow PDA, this call is used when quoting, so saving 100ms here helps a lot!
        const eventsPromise = this.findInEvents(escrowStateKey, async (event) => {
            if(event.name==="ClaimEvent") return SwapCommitStatus.PAID;
            if(event.name==="RefundEvent") return SwapCommitStatus.NOT_COMMITED;
        }, abortController.signal).catch(e => {
            abortController.abort(e)
            return null;
        });

        const escrowState = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        abortController.signal.throwIfAborted();
        if(escrowState!=null) {
            abortController.abort();
            return SwapCommitStatus.COMMITED;
        }

        //Check if paid or what
        const eventsStatus = await eventsPromise;
        abortController.signal.throwIfAborted();
        if(eventsStatus!=null) return eventsStatus;

        return SwapCommitStatus.NOT_COMMITED;
    }

    /**
     * Returns claim init instruction (offererInitializePayIn), based on the data passed in swapData
     *
     * @param swapData
     * @param timeout
     * @private
     */
    private async getInitInstruction(swapData: SolanaSwapData, timeout: BN): Promise<TransactionInstruction> {
        const claimerAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        if(swapData.payIn) {
            const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            return await this.program.methods
                .offererInitializePayIn(
                    swapData.toSwapDataStruct(),
                    [...Buffer.alloc(32, 0)],
                    timeout,
                )
                .accounts({
                    offerer: swapData.offerer,
                    claimer: swapData.claimer,
                    offererAta: ata,
                    escrowState: this.SwapEscrowState(paymentHash),
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    mint: swapData.token,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,

                    claimerAta: swapData.payOut ? claimerAta : null,
                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                })
                .instruction();
        } else {
            return await this.program.methods
                .offererInitialize(
                    swapData.toSwapDataStruct(),
                    swapData.securityDeposit,
                    swapData.claimerBounty,
                    [...(swapData.txoHash!=null ? Buffer.from(swapData.txoHash, "hex") : Buffer.alloc(32, 0))],
                    new BN(timeout)
                )
                .accounts({
                    claimer: swapData.claimer,
                    offerer: swapData.offerer,
                    offererUserData: this.SwapUserVault(swapData.offerer, swapData.token),
                    escrowState: this.SwapEscrowState(paymentHash),
                    mint: swapData.token,
                    systemProgram: SystemProgram.programId,

                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                    claimerAta: swapData.payOut ? claimerAta : null,
                })
                .instruction();
        }
    }

    /**
     * Returns instructions for claimInit (offererInitializePayIn) call wrapping the SOL to WSOL account if needed, returns null if no SOL should
     *  be wrapped
     *
     * @param swapData
     * @param feeRate
     * @private
     * @returns {{instructions: TransactionInstruction[], computeBudget: number} | null} instructions & compute budget
     *  or null if no sol should be wrapped
     */
    private getClaimInitWrapInstructions(
        swapData: SolanaSwapData,
        feeRate?: string
    ): {instructions: TransactionInstruction[], computeBudget: number} | null {
        const hashArr = feeRate==null ? [] : feeRate.split("#");
        if(hashArr.length<=1) return null;

        const arr = hashArr[1].split(";");
        if(arr.length<=1) return null;

        const balance = new BN(arr[1]);
        if(balance.gte(swapData.amount)) return null;

        const instructions: TransactionInstruction[] = [];
        let computeBudget = SolanaBase.BaseCUCosts.WRAP_SOL;
        if(arr[0]==="1") {
            computeBudget += SolanaBase.BaseCUCosts.ATA_INIT;
            instructions.push(createAssociatedTokenAccountInstruction(swapData.offerer, swapData.offererAta, swapData.offerer, swapData.token));
        }
        instructions.push(SystemProgram.transfer({
            fromPubkey: swapData.offerer,
            toPubkey: swapData.offererAta,
            lamports: BigInt(swapData.amount.sub(balance).toString(10))
        }));
        instructions.push(createSyncNativeInstruction(swapData.offererAta));
        return {instructions, computeBudget};
    }

    /**
     * Returns full message (transaction) to be signed as a claimInit (offererInitializePayIn) authorization
     *
     * @param swapData
     * @param timeout
     * @param feeRate
     * @private
     */
    private async getClaimInitMessage(swapData: SolanaSwapData, timeout: string, feeRate?: string): Promise<Transaction> {
        if(!swapData.payIn) throw new Error("Invalid payIn value");

        let computeBudget = SolanaSwapProgram.CUCosts.INIT_PAY_IN;
        let instructions: TransactionInstruction[] = [];

        const resp = this.getClaimInitWrapInstructions(swapData, feeRate);
        if(resp!=null) {
            instructions = resp.instructions;
            computeBudget += resp.computeBudget;
        }

        const tx = new Transaction();
        tx.feePayer = swapData.offerer;

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        instructions.forEach(ix => tx.add(ix));
        tx.add(await this.getInitInstruction(swapData, new BN(timeout)));
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return tx;
    }

    /**
     * Signs swap initialization authorization, using data from preFetchedBlockData if provided & still valid (subject
     *  to SIGNATURE_PREFETCH_DATA_VALIDITY)
     *
     * @param txToSign
     * @param authPrefix
     * @param authTimeout
     * @param preFetchedBlockData
     * @private
     */
    private async signSwapInitialization(
        txToSign: Transaction,
        authPrefix: string,
        authTimeout: number,
        preFetchedBlockData?: SolanaPreFetchData
    ): Promise<{prefix: string, timeout: string, signature: string}> {
        if(this.provider.signer==null) throw new Error("Unsupported");

        if(preFetchedBlockData!=null && Date.now()-preFetchedBlockData.timestamp>SIGNATURE_PREFETCH_DATA_VALIDITY) preFetchedBlockData = null;

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.findLatestParsedBlock("finalized");

        txToSign.recentBlockhash = latestBlock.blockhash;
        txToSign.sign(this.provider.signer);

        const sig = txToSign.signatures.find(e => e.publicKey.equals(this.provider.signer.publicKey));

        return {
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: latestSlot+";"+sig.signature.toString("hex")
        };
    }

    /**
     * Returns "processed" slot required for signature validation, uses preFetchedData if provided & valid
     *
     * @param preFetchedData
     * @private
     */
    private getSlotForSignature(preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        if(
            preFetchedData!=null &&
            preFetchedData.latestSlot!=null &&
            preFetchedData.latestSlot.timestamp>Date.now()-this.SLOT_CACHE_TIME
        ) {
            return Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/this.SLOT_TIME));
        }
        return this.getCachedSlot("processed");
    }

    /**
     * Returns blockhash required for signature validation, uses preFetchedData if provided & valid
     *
     * @param txSlot
     * @param preFetchedData
     * @private
     */
    private getBlockhashForSignature(txSlot: number, preFetchedData?: SolanaPreFetchVerification): Promise<string> {
        if(
            preFetchedData!=null &&
            preFetchedData.transactionSlot!=null &&
            preFetchedData.transactionSlot.slot===txSlot
        ) {
            return Promise.resolve(preFetchedData.transactionSlot.blockhash);
        }
        return this.getParsedBlock(txSlot).then(val => val.blockhash);
    }

    /**
     * Checks whether the provided signature data is valid, using preFetchedData if provided and still valid
     *
     * @param txToSign
     * @param signer
     * @param requiredPrefix
     * @param timeout
     * @param prefix
     * @param signature
     * @param preFetchedData
     * @private
     */
    private async isSignatureValid(
        txToSign: Transaction,
        signer: PublicKey,
        requiredPrefix: string,
        timeout: string,
        prefix: string,
        signature: string,
        preFetchedData?: SolanaPreFetchVerification
    ): Promise<Buffer> {
        if(prefix!==requiredPrefix) throw new SignatureVerificationError("Invalid prefix");

        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));
        const isExpired = new BN(timeout).sub(currentTimestamp).lt(new BN(this.authGracePeriod));
        if (isExpired) throw new SignatureVerificationError("Authorization expired!");

        const [transactionSlot, signatureString] = signature.split(";");
        const txSlot = parseInt(transactionSlot);

        const [latestSlot, blockhash] = await Promise.all([
            this.getSlotForSignature(preFetchedData),
            this.getBlockhashForSignature(txSlot, preFetchedData)
        ]);

        const lastValidTransactionSlot = txSlot+this.TX_SLOT_VALIDITY;
        const slotsLeft = lastValidTransactionSlot-latestSlot-SIGNATURE_SLOT_BUFFER;
        if(slotsLeft<0) throw new SignatureVerificationError("Authorization expired!");

        txToSign.recentBlockhash = blockhash;
        txToSign.addSignature(signer, Buffer.from(signatureString, "hex"));

        const valid = txToSign.verifySignatures(false);

        if(!valid) throw new SignatureVerificationError("Invalid signature!");

        return Buffer.from(blockhash);
    }

    /**
     * Gets expiry of the provided signature data, this is a minimum of slot expiry & swap signature expiry
     *
     * @param timeout
     * @param signature
     * @param preFetchedData
     * @private
     */
    private async getSignatureExpiry(
        timeout: string,
        signature: string,
        preFetchedData?: SolanaPreFetchVerification
    ): Promise<number> {
        const [transactionSlotStr, signatureString] = signature.split(";");
        const txSlot = parseInt(transactionSlotStr);

        const latestSlot = await this.getSlotForSignature(preFetchedData);
        const lastValidTransactionSlot = txSlot+this.TX_SLOT_VALIDITY;
        const slotsLeft = lastValidTransactionSlot-latestSlot-SIGNATURE_SLOT_BUFFER;

        const now = Date.now();

        const slotExpiryTime = now + (slotsLeft*this.SLOT_TIME);
        const timeoutExpiryTime = (parseInt(timeout)-this.authGracePeriod)*1000;
        const expiry = Math.min(slotExpiryTime, timeoutExpiryTime);

        if(expiry<now) return 0;

        return expiry;
    }

    /**
     * Checks whether signature is expired for good (uses "finalized" slot)
     *
     * @param signature
     * @param timeout
     * @private
     */
    private async isSignatureExpired(
        signature: string,
        timeout: string
    ): Promise<boolean> {
        const [transactionSlotStr, signatureString] = signature.split(";");
        const txSlot = parseInt(transactionSlotStr);

        const lastValidTransactionSlot = txSlot+this.TX_SLOT_VALIDITY;
        const latestSlot = await this.getCachedSlot("finalized");
        const slotsLeft = lastValidTransactionSlot-latestSlot+SIGNATURE_SLOT_BUFFER;

        if(slotsLeft<0) return true;
        if((parseInt(timeout)+this.authGracePeriod)*1000 < Date.now()) return true;
        return false;
    }

    async getClaimInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const txToSign = await this.getClaimInitMessage(swapData, authTimeout.toString(), feeRate);
        return await this.signSwapInitialization(txToSign, "claim_initialize", authTimeout, preFetchedBlockData);
    }

    async isValidClaimInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        const txToSign = await this.getClaimInitMessage(data, timeout, feeRate);
        return this.isSignatureValid(
            txToSign, data.claimer, "claim_initialize",
            timeout, prefix, signature, preFetchedData
        );
    }

    getClaimInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isClaimInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.isSignatureExpired(signature, timeout);
    }

    private async getInitMessage(swapData: SolanaSwapData, timeout: string, feeRate?: string): Promise<Transaction> {
        if(swapData.payIn) throw new Error("Invalid payIn value");

        const tx = new Transaction();
        tx.feePayer = swapData.claimer;

        SolanaSwapProgram.applyFeeRate(tx, SolanaSwapProgram.CUCosts.INIT, feeRate);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(swapData.claimer, swapData.claimerAta, swapData.claimer, swapData.token));
        tx.add(await this.getInitInstruction(swapData, new BN(timeout)));
        SolanaSwapProgram.applyFeeRateEnd(tx, SolanaSwapProgram.CUCosts.INIT, feeRate);

        return tx;
    }

    async getInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const txToSign = await this.getInitMessage(swapData, authTimeout.toString(10), feeRate);
        return await this.signSwapInitialization(txToSign, "initialize", authTimeout, preFetchedBlockData);
    }

    async isValidInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));
        const swapWillExpireTooSoon = data.expiry.sub(currentTimestamp).lt(new BN(this.authGracePeriod).add(new BN(this.claimGracePeriod)));
        if (swapWillExpireTooSoon) {
            throw new SignatureVerificationError("Swap will expire too soon!");
        }

        const txToSign = await this.getInitMessage(data, timeout, feeRate);
        return await this.isSignatureValid(
            txToSign, data.offerer, "initialize",
            timeout, prefix, signature, preFetchedData
        );
    }

    getInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.isSignatureExpired(signature, timeout);
    }

    /**
     * Gets the message to be signed as a refund authorization
     *
     * @param swapData
     * @param prefix
     * @param timeout
     * @private
     */
    private getRefundMessage(swapData: SolanaSwapData, prefix: string, timeout: string): Buffer {
        const messageBuffers = [
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(prefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[2].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[3].writeBigUInt64LE(BigInt(swapData.sequence.toString(10)));
        messageBuffers[4] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[5].writeBigUInt64LE(BigInt(timeout));

        return createHash("sha256").update(Buffer.concat(messageBuffers)).digest();
    }

    getRefundSignature(swapData: SolanaSwapData, authorizationTimeout: number): Promise<{ prefix: string; timeout: string; signature: string }> {
        if(this.provider.signer==null) throw new Error("Unsupported");
        const authPrefix = "refund";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;

        const messageBuffer = this.getRefundMessage(swapData, authPrefix, authTimeout.toString(10));
        const signature = sign.detached(messageBuffer, this.provider.signer.secretKey);

        return Promise.resolve({
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    isValidRefundAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {
        if(prefix!=="refund") throw new SignatureVerificationError("Invalid prefix");

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.authGracePeriod));
        if(isExpired) throw new SignatureVerificationError("Authorization expired!");

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = this.getRefundMessage(swapData, prefix, timeout);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, swapData.claimer.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Promise.resolve(messageBuffer);
    }

    isClaimable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeClaimer(data)) return Promise.resolve(false);
        if(this.isExpired(data)) return Promise.resolve(false);
        return this.isCommited(data);
    }

    async isCommited(swapData: SolanaSwapData): Promise<boolean> {
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return false;

        return swapData.correctPDA(account);
    }

    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        if(this.areWeOfferer(data)) currentTimestamp = currentTimestamp.sub(new BN(this.refundGracePeriod));
        if(this.areWeClaimer(data)) currentTimestamp = currentTimestamp.add(new BN(this.claimGracePeriod));
        return data.expiry.lt(currentTimestamp);
    }

    isRequestRefundable(data: SolanaSwapData): Promise<boolean> {
        //Swap can only be refunded by the offerer
        if(!this.areWeOfferer(data)) return Promise.resolve(false);

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-this.refundGracePeriod);
        const isExpired = data.expiry.lt(currentTimestamp);
        if(!isExpired) return Promise.resolve(false);

        return this.isCommited(data);
    }

    async getCommitedData(paymentHashHex: string): Promise<SolanaSwapData> {
        const paymentHash = Buffer.from(paymentHashHex, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return null;

        return SolanaSwapData.fromEscrowState(account);
    }

    createSwapData(
        type: ChainSwapType,
        offerer: string,
        claimer: string,
        token: TokenAddress,
        amount: BN,
        paymentHash: string,
        sequence: BN,
        expiry: BN,
        escrowNonce: BN,
        confirmations: number,
        payIn: boolean,
        payOut: boolean,
        securityDeposit: BN,
        claimerBounty: BN
    ): Promise<SolanaSwapData> {
        const tokenAddr: PublicKey = typeof(token)==="string" ? new PublicKey(token) : token;
        const offererKey = offerer==null ? null : new PublicKey(offerer);
        const claimerKey = claimer==null ? null : new PublicKey(claimer);
        return Promise.resolve(new SolanaSwapData(
            offererKey,
            claimerKey,
            tokenAddr,
            amount,
            paymentHash,
            sequence,
            expiry,
            escrowNonce,
            confirmations,
            payOut,
            type==null ? null : SolanaSwapData.typeToKind(type),
            payIn,
            offererKey==null ? null : payIn ? getAssociatedTokenAddressSync(token, offererKey) : PublicKey.default,
            claimerKey==null ? null : payOut ? getAssociatedTokenAddressSync(token, claimerKey) : PublicKey.default,
            securityDeposit,
            claimerBounty,
            null
        ));
    }

    async claimWithSecret(
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        waitForConfirmation?: boolean,
        abortSignal?: AbortSignal,
        feeRate?: string
    ): Promise<string> {
        const result = await this.txsClaimWithSecret(swapData, secret, checkExpiry, initAta, feeRate);
        const [signature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);
        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return signature;
    }

    /**
     * Checks if ATA exists, if not, throws an error (if initAta=false)or adds ata init IX to the
     *  IX array (if initAta=true)
     *
     * @param swapData
     * @param initAta
     * @param instructions
     * @private
     * @returns {Promise<number>} a compute budget required for the added instructions
     */
    private async checkAtaExistsAndInit(
        swapData: SolanaSwapData,
        initAta: boolean,
        instructions: TransactionInstruction[]
    ): Promise<number> {
        if(!swapData.isPayOut()) return 0;

        const account = await tryWithRetries<Account>(
            () => this.getATAOrNull(swapData.claimerAta),
            this.retryPolicy
        );
        if(account!=null) return 0;

        if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

        const generatedAtaAddress = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        if(!generatedAtaAddress.equals(swapData.claimerAta)) {
            throw new SwapDataVerificationError("Invalid claimer token account address");
        }

        instructions.push(
            createAssociatedTokenAccountInstruction(
                this.provider.publicKey,
                generatedAtaAddress,
                swapData.claimer,
                swapData.token
            )
        );

        return SolanaSwapProgram.BaseCUCosts.ATA_INIT;
    }

    /**
     * Checks if the swap output should be unwrapped and if yes adds the unwrap instruction to the IX array
     *
     * @param swapData
     * @param instructions
     * @private
     * @returns {number} compute budget required for the added instructions
     */
    private checkAndUnwrap(swapData: SolanaSwapData, instructions: TransactionInstruction[]): number {
        const unwrap = swapData.isPayOut() && swapData.token.equals(this.WSOL_ADDRESS);
        if(!unwrap) return 0;

        instructions.push(
            createCloseAccountInstruction(swapData.claimerAta, this.provider.publicKey, this.provider.publicKey)
        );
        return SolanaSwapProgram.BaseCUCosts.ATA_CLOSE;
    }

    private async ixClaimWithSecret(swapData: SolanaSwapData, secret: string) {
        if(swapData.isPayOut()) {
            return {
                instruction: await this.program.methods
                    .claimerClaimPayOut(Buffer.from(secret, "hex"))
                    .accounts({
                        signer: this.provider.publicKey,
                        initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                        escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                        claimerAta: swapData.claimerAta,
                        vault: this.SwapVault(swapData.token),
                        vaultAuthority: this.SwapVaultAuthority,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        data: null
                    })
                    .instruction(),
                computeBudget: SolanaSwapProgram.CUCosts.CLAIM_PAY_OUT
            };
        } else {
            return {
                instructions: await this.program.methods
                    .claimerClaim(Buffer.from(secret, "hex"))
                    .accounts({
                        signer: this.provider.publicKey,
                        initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                        escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                        claimerUserData: this.SwapUserVault(swapData.claimer, swapData.token),
                        data: null
                    })
                    .instruction(),
                computeBudget: SolanaSwapProgram.CUCosts.CLAIM
            };
        }
    }

    async txsClaimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: string, skipAtaCheck?: boolean): Promise<SolanaTx[]> {
        //We need to be sure that this transaction confirms in time, otherwise we reveal the secret to the counterparty
        // and won't claim the funds
        if(checkExpiry && this.isExpired(swapData)) {
            throw new SwapDataVerificationError("Not enough time to reliably pay the invoice");
        }
        if(feeRate==null) feeRate = await this.getClaimFeeRate(swapData);

        const instructions: TransactionInstruction[] = [];
        let computeBudget: number = 0;

        if(!skipAtaCheck) computeBudget += await this.checkAtaExistsAndInit(swapData, initAta, instructions);

        const {instruction, computeBudget: claimComputeBudget} = await this.ixClaimWithSecret(swapData, secret);
        computeBudget += claimComputeBudget;
        instructions.push(instruction);

        computeBudget += this.checkAndUnwrap(swapData, instructions);

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;
        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        instructions.forEach(ix => tx.add(ix));
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx: tx,
            signers: []
        }];
    }

    async claimWithTxData(
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        waitForConfirmation?: boolean,
        abortSignal?: AbortSignal,
        feeRate?: string
    ): Promise<string> {
        const data: {storageAcc: PublicKey} = {
            storageAcc: null
        };

        const txs = await this.txsClaimWithTxData(swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, data, feeRate);

        if(txs===null) throw new Error("Btc relay not synchronized to required blockheight!");

        const [signature] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal);

        await this.removeDataAccount(data.storageAcc);

        return signature;
    }

    /**
     * Gets committed header, identified by blockhash & blockheight, determines required BTC relay blockheight based on
     *  requiredConfirmations
     * If synchronizer is passed & blockhash is not found, it produces transactions to sync up the btc relay to the
     *  current chain tip & adds them to the txs array
     *
     * @param blockheight
     * @param requiredConfirmations
     * @param blockhash
     * @param txs
     * @param synchronizer
     * @private
     */
    private async getCommitedHeaderAndSynchronize(
        blockheight: number,
        requiredConfirmations: number,
        blockhash: string,
        txs: SolanaTx[],
        synchronizer?: RelaySynchronizer<SolanaBtcStoredHeader, SolanaTx, any>,
    ): Promise<SolanaBtcStoredHeader> {
        const requiredBlockheight = blockheight+requiredConfirmations-1;

        const result = await tryWithRetries(
            () => this.btcRelay.retrieveLogAndBlockheight({
                blockhash: blockhash
            }, requiredBlockheight),
            this.retryPolicy
        );

        if(result!=null) return result.header;

        //Need to synchronize
        if(synchronizer==null) return null;

        //TODO: We don't have to synchronize to tip, only to our required blockheight
        const resp = await synchronizer.syncToLatestTxs();
        logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay not synchronized to required blockheight, "+
            "synchronizing ourselves in "+resp.txs.length+" txs");
        logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay computed header map: ",resp.computedHeaderMap);
        resp.txs.forEach(tx => txs.push(tx));

        //Retrieve computed header
        return resp.computedHeaderMap[blockheight];
    }

    private async writeTransactionData(
        reversedTxId: Buffer,
        writeData: Buffer,
        txs: SolanaTx[],
        feeRate: string
    ): Promise<PublicKey> {
        let txDataKey: Signer;
        let fetchedDataAccount: AccountInfo<Buffer> = null;
        if(this.provider.signer!=null) {
            txDataKey = this.SwapTxDataAlt(reversedTxId, this.provider.signer);
            fetchedDataAccount = await tryWithRetries<AccountInfo<Buffer>>(
                () => this.provider.connection.getAccountInfo(txDataKey.publicKey),
                this.retryPolicy
            );
        } else {
            const secret = randomBytes(32);
            txDataKey = this.SwapTxDataAltBuffer(reversedTxId, secret);
        }

        let pointer = 0;
        if(fetchedDataAccount==null) {
            const dataSize = writeData.length;
            const accountSize = 32+dataSize;
            const lamports = await tryWithRetries(
                () => this.provider.connection.getMinimumBalanceForRentExemption(accountSize),
                this.retryPolicy
            );

            const accIx = SystemProgram.createAccount({
                fromPubkey: this.provider.publicKey,
                newAccountPubkey: txDataKey.publicKey,
                lamports,
                space: accountSize,
                programId: this.program.programId
            });

            const initIx = await this.program.methods
                .initData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            const writeLen = Math.min(writeData.length-pointer, 420);

            const writeIx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, pointer+writeLen))
                .accounts({
                    signer: this.provider.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length);

            pointer += writeLen;

            const initTx = new Transaction();
            initTx.feePayer = this.provider.publicKey;

            SolanaSwapProgram.applyFeeRate(initTx, SolanaSwapProgram.CUCosts.DATA_CREATE_AND_WRITE, feeRate);
            initTx.add(accIx);
            initTx.add(initIx);
            initTx.add(writeIx);
            SolanaSwapProgram.applyFeeRateEnd(initTx, SolanaSwapProgram.CUCosts.DATA_CREATE_AND_WRITE, feeRate);

            await this.saveDataAccount(txDataKey.publicKey);
            txs.push({
                tx: initTx,
                signers: [txDataKey]
            });
        }

        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const writeTx = new Transaction();
            writeTx.feePayer = this.provider.publicKey;

            const writeIx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, pointer+writeLen))
                .accounts({
                    signer: this.provider.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            SolanaSwapProgram.applyFeeRate(writeTx, SolanaSwapProgram.CUCosts.DATA_WRITE, feeRate);
            writeTx.add(writeIx);
            SolanaSwapProgram.applyFeeRateEnd(writeTx, SolanaSwapProgram.CUCosts.DATA_WRITE, feeRate);

            txs.push({
                tx: writeTx,
                signers: []
            });

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length);

            pointer += writeLen;
        }

        return txDataKey.publicKey;
    }

    async txsClaimWithTxData(
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        storageAccHolder?: {storageAcc: PublicKey},
        feeRate?: string
    ): Promise<SolanaTx[] | null> {
        if(feeRate==null) feeRate = await this.getClaimFeeRate(swapData);

        const instructions: TransactionInstruction[] = [];
        let computeBudget: number = 0;
        computeBudget += await this.checkAtaExistsAndInit(swapData, initAta, instructions);

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);
        console.log("[To BTC: Solana.Claim] Merkle proof computed: ", merkleProof);

        const txs: SolanaTx[] = [];
        await this.getCommitedHeaderAndSynchronize(blockheight, swapData.getConfirmations(), tx.blockhash, txs, synchronizer);

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            Buffer.from(tx.hex, "hex")
        ]);
        console.log("[To BTC: Solana.Claim] Writing transaction data: ", writeData.toString("hex"));

        const storeDataKey = await this.writeTransactionData(merkleProof.reversedTxId, writeData, txs, feeRate);
        if(storageAccHolder!=null) storageAccHolder.storageAcc = storeDataKey;

        console.log("[To BTC: Solana.Claim] Tx data written");

        const verifyIx = await this.btcRelay.createVerifyIx(merkleProof.reversedTxId, swapData.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader);
        let claimIx: TransactionInstruction;
        let computeBudget: number;
        if(swapData.isPayOut()) {
            computeBudget = SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN_PAY_OUT;
            claimIx = await this.program.methods
                .claimerClaimPayOut(Buffer.alloc(0))
                .accounts({
                    signer: this.provider.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    claimerAta: swapData.claimerAta,
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    data: txDataKey.publicKey
                })
                .instruction();
        } else {
            computeBudget = SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN;
            claimIx = await this.program.methods
                .claimerClaim(Buffer.alloc(0))
                .accounts({
                    signer: this.provider.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    claimerUserData: this.SwapUserVault(swapData.claimer, swapData.token),
                    data: txDataKey.publicKey
                })
                .instruction();
        }

        if(ataInitIx!=null) {
            const ataInitTx = new Transaction();
            ataInitTx.feePayer = this.provider.publicKey;

            SolanaSwapProgram.applyFeeRate(ataInitTx, SolanaBase.BaseCUCosts.ATA_INIT, feeRate);
            ataInitTx.add(ataInitIx);
            SolanaSwapProgram.applyFeeRateEnd(ataInitTx, SolanaBase.BaseCUCosts.ATA_INIT, feeRate);

            txs.push({
                tx: ataInitTx,
                signers: []
            });
        }

        const solanaTx = new Transaction();
        solanaTx.feePayer = this.provider.publicKey;

        solanaTx.add(verifyIx);
        SolanaSwapProgram.applyFeeRate(solanaTx, null, feeRate);
        solanaTx.add(claimIx);
        SolanaSwapProgram.applyFeeRateEnd(solanaTx, null, feeRate);

        // if(Utils.getTxSize(solanaTx, this.provider.publicKey)>1232) {
        //     //TX too large
        //     solanaTx.instructions.pop();
        // }

        txs.push({
            tx: solanaTx,
            signers: []
        });

        if(swapData.isPayOut()) {
            if (swapData.token.equals(this.WSOL_ADDRESS) && swapData.claimer.equals(this.provider.publicKey)) {
                //Move to normal SOL
                const tx = new Transaction();
                tx.feePayer = this.provider.publicKey;
                SolanaSwapProgram.applyFeeRate(tx, SolanaBase.BaseCUCosts.ATA_CLOSE, feeRate);
                tx.add(
                    createCloseAccountInstruction(swapData.claimerAta, this.provider.publicKey, this.provider.publicKey)
                );
                SolanaSwapProgram.applyFeeRateEnd(tx, SolanaBase.BaseCUCosts.ATA_CLOSE, feeRate);
                txs.push({
                    tx,
                    signers: []
                });
            }
        }

        return txs;

    }

    async refund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefund(swapData, check, initAta, feeRate);

        const [signature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signature;
    }

    async txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {

        if(check) {
            if(!(await tryWithRetries(() => this.isRequestRefundable(swapData), this.retryPolicy))) {
                throw new SwapDataVerificationError("Not refundable yet!");
            }
        }

        if(feeRate==null) feeRate = await this.getRefundFeeRate(swapData)

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        let ata: PublicKey = null;

        let ix: TransactionInstruction;

        let computeBudget: number;
        if(swapData.isPayIn()) {
            computeBudget = SolanaSwapProgram.CUCosts.REFUND_PAY_OUT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);

            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, swapData.offerer, swapData.token));
            }

            ix = await this.program.methods
                .offererRefundPayIn(new BN(0))
                .accounts({
                    offerer: swapData.offerer,
                    claimer: swapData.claimer,
                    offererAta: ata,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                    ixSysvar: null
                })
                .instruction();
        } else {
            computeBudget = SolanaSwapProgram.CUCosts.REFUND;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);

            ix = await this.program.methods
                .offererRefund(new BN(0))
                .accounts({
                    offerer: swapData.offerer,
                    claimer: swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    offererUserData: this.SwapUserVault(swapData.offerer, swapData.token),
                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                    ixSysvar: null
                })
                .instruction();
        }

        tx.add(ix);

        if(swapData.isPayIn()) {
            if (swapData.token.equals(this.WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(ata, this.provider.publicKey, this.provider.publicKey)
                );
            }
        }

        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx,
            signers: []
        }];
    }

    async refundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsRefundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        if(check) {
            if(!(await tryWithRetries(() => this.isCommited(swapData), this.retryPolicy))) {
                throw new SwapDataVerificationError("Not correctly committed");
            }
        }

        const messageBuffer = await tryWithRetries(
            () => this.isValidRefundAuthorization(swapData, timeout, prefix, signature),
            this.retryPolicy,
            (e) => e instanceof SignatureVerificationError
        );
        const signatureBuffer = Buffer.from(signature, "hex");

        if(feeRate==null) feeRate = await this.getRefundFeeRate(swapData);

        console.log("[SolanaSwapProgram] txsRefundsWithAuthorization: feeRate: ", feeRate);

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.claimer.toBuffer(),
            signature: signatureBuffer
        }));


        let ata: PublicKey = null;

        let ix: TransactionInstruction;
        let computeBudget: number;

        if(swapData.isPayIn()) {
            computeBudget = SolanaSwapProgram.CUCosts.REFUND_PAY_OUT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, swapData.offerer, swapData.token));
            }

            ix = await this.program.methods
                .offererRefundPayIn(new BN(timeout))
                .accounts({
                    offerer: swapData.offerer,
                    claimer: swapData.claimer,
                    offererAta: ata,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
                })
                .instruction();
        } else {
            computeBudget = SolanaSwapProgram.CUCosts.REFUND;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            ix = await this.program.methods
                .offererRefund(new BN(timeout))
                .accounts({
                    offerer: swapData.offerer,
                    claimer: swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    offererUserData: this.SwapUserVault(swapData.offerer, swapData.token),
                    claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null,
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
                })
                .instruction();
        }

        tx.add(ix);

        if(swapData.isPayIn()) {
            if (swapData.token.equals(this.WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(ata, this.provider.publicKey, this.provider.publicKey)
                );
            }
        }
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        console.log("[SolanaSwapProgram] txsRefundsWithAuthorization: constructed TX: ", tx);

        return [{
            tx,
            signers: []
        }];

    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInitPayIn(swapData,timeout,prefix,signature,skipChecks,feeRate);

        const signatures = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signatures[signatures.length-1];
    }

    async txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {

        if(!skipChecks) {
            const [_, payStatus] = await Promise.all([
                tryWithRetries(
                    () => this.isValidClaimInitAuthorization(swapData, timeout, prefix, signature, feeRate),
                    this.retryPolicy,
                    (e) => e instanceof SignatureVerificationError
                ),
                tryWithRetries(() => this.getPaymentHashStatus(swapData.paymentHash), this.retryPolicy)
            ]);

            if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
                throw new SwapDataVerificationError("Invoice already being paid for or paid");
            }
        }

        const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

        const txs: SolanaTx[] = [];

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        if(feeRate==null || feeRate.split("#").length<2) {
            if(swapData.token.equals(this.WSOL_ADDRESS)) {
                let balance = new BN(0);
                let accountExists = false;
                try {
                    const ataAcc = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);

                    if(ataAcc!=null) {
                        accountExists = true;
                        balance = balance.add(new BN(ataAcc.amount.toString()));
                    }
                } catch (e) {}
                if(balance.lt(swapData.amount)) {
                    const tx = new Transaction();
                    tx.feePayer = swapData.offerer;

                    let computeBudget: number = SolanaBase.BaseCUCosts.WRAP_SOL;
                    //Need to wrap some more
                    const remainder = swapData.amount.sub(balance);
                    if(!accountExists) {
                        //Need to create account
                        computeBudget += SolanaBase.BaseCUCosts.ATA_INIT;
                        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
                        tx.add(createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, this.provider.publicKey, swapData.token));
                    } else {
                        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
                    }
                    tx.add(SystemProgram.transfer({
                        fromPubkey: this.provider.publicKey,
                        toPubkey: ata,
                        lamports: remainder.toNumber()
                    }));
                    tx.add(createSyncNativeInstruction(ata));

                    SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

                    tx.recentBlockhash = block.blockhash;
                    tx.lastValidBlockHeight = block.blockHeight + this.TX_SLOT_VALIDITY;

                    txs.push({
                        tx,
                        signers: []
                    });
                }
            }
        }

        const tx = await this.getClaimInitMessage(swapData, timeout, feeRate);

        tx.recentBlockhash = block.blockhash;
        tx.lastValidBlockHeight = block.blockHeight + this.TX_SLOT_VALIDITY;
        tx.addSignature(swapData.claimer, Buffer.from(signatureStr, "hex"));

        txs.push({
            tx,
            signers: []
        });

        return txs;

    }

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInit(swapData,timeout,prefix,signature,txoHash,skipChecks,feeRate);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {

        if(!skipChecks) {
            await tryWithRetries(
                () => this.isValidInitAuthorization(swapData, timeout, prefix, signature, feeRate),
                this.retryPolicy,
                (e) => e instanceof SignatureVerificationError
            );
        }

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        const txns: {tx: Transaction, signers: Signer[]}[] = [];

        const claimerAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        const tx = new Transaction();
        tx.feePayer = swapData.claimer;

        const result = await this.getInitInstruction(swapData, new BN(timeout));

        SolanaSwapProgram.applyFeeRate(tx, SolanaSwapProgram.CUCosts.INIT, feeRate);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(this.provider.publicKey, claimerAta, this.provider.publicKey, swapData.token));
        tx.add(result);
        SolanaSwapProgram.applyFeeRateEnd(tx, SolanaSwapProgram.CUCosts.INIT, feeRate);

        tx.recentBlockhash = block.blockhash;
        tx.lastValidBlockHeight = block.blockHeight + this.TX_SLOT_VALIDITY;
        tx.addSignature(swapData.offerer, Buffer.from(signatureStr, "hex"));

        txns.push({tx, signers: []});

        return txns;

    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string[]> {

        const txsCommit = await this.txsInit(swapData, timeout, prefix, signature, null, skipChecks, feeRate);
        const txsClaim = await this.txsClaimWithSecret(swapData, secret, true, false, feeRate, true);

        return await this.sendAndConfirm(txsCommit.concat(txsClaim), waitForConfirmation, abortSignal);

    }

    async getIntermediaryData(address: string, token: PublicKey): Promise<{
        balance: BN,
        reputation: IntermediaryReputationType
    }> {
        const data: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(new PublicKey(address), token));

        if(data==null) return null;

        const response: any = [];

        for(let i=0;i<data.successVolume.length;i++) {
            response[i] = {
                successVolume: data.successVolume[i],
                successCount: data.successCount[i],
                failVolume: data.failVolume[i],
                failCount: data.failCount[i],
                coopCloseVolume: data.coopCloseVolume[i],
                coopCloseCount: data.coopCloseCount[i]
            };
        }

        return {
            balance: data.amount,
            reputation: response
        };
    }

    async getIntermediaryReputation(address: string, token: PublicKey): Promise<IntermediaryReputationType> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        return intermediaryData?.reputation;
    }

    async getIntermediaryBalance(address: string, token: PublicKey): Promise<BN> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        return intermediaryData?.balance;
    }

    getInitPayInFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {

        const accounts: PublicKey[] = [];

        if(offerer!=null) accounts.push(new PublicKey(offerer));
        if(token!=null) {
            accounts.push(this.SwapVault(token));
            if(offerer!=null) accounts.push(getAssociatedTokenAddressSync(token, new PublicKey(offerer)));
            if(claimer!=null) accounts.push(this.SwapUserVault(new PublicKey(claimer), token));
        }
        if(paymentHash!=null) accounts.push(this.SwapEscrowState(Buffer.from(paymentHash, "hex")));

        return Promise.all([
            this.getFeeRate(accounts),
            token!=null && offerer!=null && token.equals(this.WSOL_ADDRESS) ? this.getATAOrNull(getAssociatedTokenAddressSync(token, new PublicKey(offerer))) : Promise.resolve(null)
        ]).then(([feeRate, _account]) => {
            if(token!=null && offerer!=null && token.equals(this.WSOL_ADDRESS)) {
                let balance: BN;
                let accountExists: boolean;
                const account: Account = _account;
                if(account!=null) {
                    accountExists = true;
                    balance = new BN(account.amount.toString());
                } else {
                    accountExists = false;
                    balance = new BN(0);
                }
                return feeRate+"#"+(accountExists ? "0" : "1")+";"+balance.toString(10);
            } else {
                return feeRate;
            }
        });

    }

    getInitFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {

        const accounts: PublicKey[] = [];

        if(offerer!=null && token!=null) accounts.push(this.SwapUserVault(new PublicKey(offerer), token));
        if(claimer!=null) accounts.push(new PublicKey(claimer))
        if(paymentHash!=null) accounts.push(this.SwapEscrowState(Buffer.from(paymentHash, "hex")));

        return this.getFeeRate(accounts);

    }

    getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {

        const accounts: PublicKey[] = [];
        if(swapData.payIn) {
            if(swapData.token!=null) accounts.push(this.SwapVault(swapData.token));
            if(swapData.offerer!=null) accounts.push(swapData.offerer);
            if(swapData.claimer!=null) accounts.push(swapData.claimer);
            if(swapData.offererAta!=null && !swapData.offererAta.equals(PublicKey.default)) accounts.push(swapData.offererAta);
        } else {
            if(swapData.offerer!=null) {
                accounts.push(swapData.offerer);
                if(swapData.token!=null) accounts.push(this.SwapUserVault(swapData.offerer, swapData.token));
            }
            if(swapData.claimer!=null) accounts.push(swapData.claimer);
        }

        if(swapData.paymentHash!=null) accounts.push(this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));

        return this.getFeeRate(accounts);

    }

    getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {

        const accounts: PublicKey[] = [this.provider.publicKey];
        if(swapData.payOut) {
            if(swapData.token!=null) accounts.push(this.SwapVault(swapData.token));
            if(swapData.payIn) {
                if(swapData.offerer!=null) accounts.push(swapData.offerer);
            } else {
                if(swapData.claimer!=null) accounts.push(swapData.claimer);
            }
            if(swapData.claimerAta!=null && !swapData.claimerAta.equals(PublicKey.default)) accounts.push(swapData.claimerAta);
        } else {
            if(swapData.claimer!=null && swapData.token!=null) accounts.push(this.SwapUserVault(swapData.claimer, swapData.token));

            if(swapData.payIn) {
                if(swapData.offerer!=null) accounts.push(swapData.offerer);
            } else {
                if(swapData.claimer!=null) accounts.push(swapData.claimer);
            }
        }

        if(swapData.paymentHash!=null) accounts.push(this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));

        return this.getFeeRate(accounts);
    }

    async getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-ESCROW_STATE_RENT_EXEMPT+5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? SolanaSwapProgram.CUCosts.CLAIM_PAY_OUT : SolanaSwapProgram.CUCosts.CLAIM
        ) : (
            swapData.payOut ? SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN_PAY_OUT : SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN
        );
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(-ESCROW_STATE_RENT_EXEMPT+5000).add(priorityLamports);
    }

    async getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? SolanaSwapProgram.CUCosts.CLAIM_PAY_OUT : SolanaSwapProgram.CUCosts.CLAIM
        ) : (
            swapData.payOut ? SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN_PAY_OUT : SolanaSwapProgram.CUCosts.CLAIM_ONCHAIN
        );
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        //Include rent exempt in claim fee, to take into consideration worst case cost when user destroys ATA
        return new BN(this.SPL_ATA_RENT_EXEMPT+5000).add(priorityLamports);
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    async getCommitFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(ESCROW_STATE_RENT_EXEMPT+10000);

        feeRate =
            feeRate
            ||
            (swapData.payIn
                ? await this.getInitPayInFeeRate(swapData.getOfferer(), swapData.getClaimer(), swapData.token, swapData.paymentHash)
                : await this.getInitFeeRate(swapData.getOfferer(), swapData.getClaimer(), swapData.token, swapData.paymentHash));

        const computeBudget = swapData.payIn ? SolanaSwapProgram.CUCosts.INIT_PAY_IN : SolanaSwapProgram.CUCosts.INIT;
        const baseFee = swapData.payIn ? 10000 : 10000 + 5000;
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(ESCROW_STATE_RENT_EXEMPT+baseFee).add(priorityLamports);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-ESCROW_STATE_RENT_EXEMPT+10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? SolanaSwapProgram.CUCosts.REFUND_PAY_OUT : SolanaSwapProgram.CUCosts.REFUND;
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(-ESCROW_STATE_RENT_EXEMPT+10000).add(priorityLamports);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRawRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? SolanaSwapProgram.CUCosts.REFUND_PAY_OUT : SolanaSwapProgram.CUCosts.REFUND;
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(10000).add(priorityLamports);
    }

    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.claimer = this.provider.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
    }

    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.provider.publicKey;
        swapData.offererAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
        swapData.payIn = true;
    }

    async withdraw(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsWithdraw(token, amount, feeRate);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);

        feeRate = feeRate || await this.getFeeRate([this.provider.publicKey, ata, this.SwapUserVault(this.provider.publicKey, token), this.SwapVault(token)]);

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        let computeBudget = SolanaSwapProgram.CUCosts.WITHDRAW;

        const account = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);
        if(account==null) {
            computeBudget += SolanaBase.BaseCUCosts.ATA_INIT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            tx.add(
                createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, this.provider.publicKey, token)
            );
        } else {
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        }

        let ix = await this.program.methods
            .withdraw(new BN(amount))
            .accounts({
                signer: this.provider.publicKey,
                signerAta: ata,
                userData: this.SwapUserVault(this.provider.publicKey, token),
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: token,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        tx.add(ix);

        if (this.WSOL_ADDRESS.equals(token)) {
            //Move to normal SOL
            tx.add(
                createCloseAccountInstruction(ata, this.provider.publicKey, this.provider.publicKey)
            );
        }

        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx,
            signers: []
        }];
    }
    async deposit(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsDeposit(token, amount, feeRate);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);
        
        feeRate = feeRate || await this.getFeeRate([this.provider.publicKey, ata, this.SwapUserVault(this.provider.publicKey, token), this.SwapVault(token)]);

        let computeBudget = SolanaSwapProgram.CUCosts.DEPOSIT;
        const ixs: TransactionInstruction[] = [];

        if(this.WSOL_ADDRESS.equals(token)) {
            let accountExists: boolean = false;
            let balance: BN = new BN(0);

            const ataAcc = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);
            if(ataAcc!=null) {
                accountExists = true;
                balance = balance.add(new BN(ataAcc.amount.toString()));
            }
            if(balance.lt(amount)) {
                computeBudget += SolanaBase.BaseCUCosts.WRAP_SOL;
                const remainder = amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    computeBudget += SolanaBase.BaseCUCosts.ATA_INIT;
                    ixs.push(createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, this.provider.publicKey, token));
                }
                ixs.push(SystemProgram.transfer({
                    fromPubkey: this.provider.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                ixs.push(createSyncNativeInstruction(ata));
            }
        }

        const depositIx = await this.program.methods
            .deposit(new BN(amount))
            .accounts({
                signer: this.provider.publicKey,
                signerAta: ata,
                userData: this.SwapUserVault(this.provider.publicKey, token),
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: token,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        ixs.forEach(ix => tx.add(ix));
        tx.add(depositIx);
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx,
            signers: []
        }]
    }

}
