import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, BorshCoder, EventParser, IdlAccounts, IdlEvents, IdlTypes, Program} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    AccountInfo,
    Commitment,
    ComputeBudgetProgram,
    Ed25519Program,
    Keypair, ParsedAccountsModeBlockResponse,
    PublicKey,
    SendOptions,
    Signer,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
    Transaction,
    TransactionExpiredBlockheightExceededError,
    TransactionInstruction
} from "@solana/web3.js";
import {createHash, randomBytes} from "crypto";
import {sign} from "tweetnacl";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import * as programIdl from "./programIdl.json";
import {IStorageManager, SwapContract, ChainSwapType, TokenAddress, IntermediaryReputationType,
    SwapCommitStatus, SignatureVerificationError, CannotInitializeATAError, SwapDataVerificationError} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {RelaySynchronizer, StorageObject} from "crosslightning-base/dist";
import Utils from "./Utils";
import * as bs58 from "bs58";
import {tryWithRetries} from "../../utils/RetryUtils";
import {
    Account,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
    TokenAccountNotFoundError,
    TOKEN_PROGRAM_ID,
    createSyncNativeInstruction,
    getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction
} from "@solana/spl-token";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";
import {SwapProgram} from "./programTypes";
import {SwapTypeEnum} from "./SwapTypeEnum";

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const TX_DATA_SEED = "data";

type SolTx = {tx: Transaction, signers: Signer[]};

const WSOL_ADDRESS = new PublicKey("So11111111111111111111111111111111111111112");

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

const SLOT_TIME = 400;
const SLOT_BUFFER = 20;
const TX_SLOT_VALIDITY = 151;

const SLOT_CACHE_SLOTS = 12;
const SLOT_CACHE_TIME = SLOT_CACHE_SLOTS*SLOT_TIME;

const PREFETCHED_DATA_VALIDITY = 5000;

const ESCROW_STATE_RENT_EXEMPT = 2658720;

const CUCosts = {
    CLAIM: 25000,
    CLAIM_PAY_OUT: 50000,
    INIT: 90000,
    INIT_PAY_IN: 50000,
    WRAP_SOL: 10000,
    DATA_REMOVE: 50000,
    DATA_CREATE_AND_WRITE: 15000,
    DATA_WRITE: 15000,
    CLAIM_ONCHAIN: 200000,
    CLAIM_ONCHAIN_PAY_OUT: 200000,
    ATA_CLOSE: 10000,
    ATA_INIT: 40000,
    REFUND: 15000,
    REFUND_PAY_OUT: 50000,

    WITHDRAW: 50000,
    DEPOSIT: 50000,
    TRANSFER: 50000
};

export type SolanaRetryPolicy = {
    maxRetries?: number,
    delay?: number,
    exponential?: boolean,
    transactionResendInterval?: number
}

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

export class SolanaSwapProgram implements SwapContract<SolanaSwapData, SolTx, SolanaPreFetchData, SolanaPreFetchVerification> {

    blockCache: {
        [slotNumber: number]: ParsedAccountsModeBlockResponse
    } = {};

    //Parsed block caching
    private async findLatestParsedBlock(commitment: Commitment): Promise<{
        block: ParsedAccountsModeBlockResponse,
        slot: number
    }> {
        let slot = await this.signer.connection.getSlot(commitment);

        if(this.blockCache[slot]!=null) {
            return {
                block: this.blockCache[slot],
                slot
            };
        }

        let error;
        for(let i=0;i<10;i++) {
            try {
                const fetchedBlock = await this.signer.connection.getParsedBlock(slot, {
                    transactionDetails: "none",
                    commitment: "confirmed",
                    rewards: false
                });
                this.blockCache[slot] = fetchedBlock;

                return {
                    block: fetchedBlock,
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

    //Parsed block caching
    private async getParsedBlock(slot: number): Promise<ParsedAccountsModeBlockResponse> {
        if(this.blockCache[slot]!=null) {
            return this.blockCache[slot];
        }

        const fetchedBlock = await this.signer.connection.getParsedBlock(slot, {
            transactionDetails: "none",
            commitment: "confirmed",
            rewards: false
        });
        this.blockCache[slot] = fetchedBlock;

        return fetchedBlock;
    }


    private slotCache: {
        [key in Commitment]?: {
            slot: number,
            timestamp: number
        }
    } = {};

    private async getCachedSlotAndTimestamp(commitment: Commitment): Promise<{
        slot: number,
        timestamp: number
    }> {
        if(this.slotCache[commitment]!=null && Date.now()-this.slotCache[commitment].timestamp<SLOT_CACHE_TIME) {
            return this.slotCache[commitment];
        }

        const slot = await this.signer.connection.getSlot(commitment);

        return this.slotCache[commitment] = {
            slot,
            timestamp: Date.now()
        };
    }

    private async getCachedSlot(commitment: Commitment): Promise<number> {
        if(this.slotCache[commitment]!=null && Date.now()-this.slotCache[commitment].timestamp<SLOT_CACHE_TIME) {
            return this.slotCache[commitment].slot + Math.floor((Date.now()-this.slotCache[commitment].timestamp)/SLOT_TIME);
        }

        const slot = await this.signer.connection.getSlot(commitment);

        this.slotCache[commitment] = {
            slot,
            timestamp: Date.now()
        };

        return slot;
    }

    claimWithSecretTimeout: number = 45;
    claimWithTxDataTimeout: number = 120;
    refundTimeout: number = 45;

    readonly claimGracePeriod: number = 10*60;
    readonly refundGracePeriod: number = 10*60;
    readonly authGracePeriod: number = 5*60;

    readonly storage: IStorageManager<StoredDataAccount>;

    private readonly signer: AnchorProvider & {signer?: Signer};
    readonly program: Program<SwapProgram>;
    readonly coder: BorshCoder;
    readonly eventParser: EventParser;

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

    readonly retryPolicy: SolanaRetryPolicy;
    readonly solanaFeeEstimator: SolanaFeeEstimator;

    constructor(
        signer: AnchorProvider & {signer?: Signer},
        btcRelay: SolanaBtcRelay<any>,
        storage: IStorageManager<StoredDataAccount>,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFeeEstimator = btcRelay.solanaFeeEstimator || new SolanaFeeEstimator(signer.connection)
    ) {
        this.signer = signer;
        this.program = new Program<SwapProgram>(programIdl as any, programAddress || programIdl.metadata.address, signer);
        this.coder = new BorshCoder(programIdl as any);
        this.eventParser = new EventParser(this.program.programId, this.coder);

        this.btcRelay = btcRelay;

        this.storage = storage;

        this.solanaFeeEstimator = solanaFeeEstimator;

        this.SwapVaultAuthority = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];

        this.retryPolicy = retryPolicy;
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

    async start(): Promise<void> {
        await this.storage.init();

        const accounts: StoredDataAccount[] = await this.storage.loadData(StoredDataAccount);

        console.log("[To BTC: Solana.GC] Running GC on previously initialized data account");

        for(let acc of accounts) {
            const publicKey = new PublicKey(acc.accountKey);

            try {
                const fetchedDataAccount: AccountInfo<Buffer> = await this.signer.connection.getAccountInfo(publicKey);
                if(fetchedDataAccount!=null) {
                    console.log("[To BTC: Solana.GC] Will erase previous data account");
                    const eraseTx = await this.program.methods
                        .closeData()
                        .accounts({
                            signer: this.signer.publicKey,
                            data: publicKey
                        })
                        .transaction();

                    eraseTx.feePayer = this.signer.publicKey;

                    const feeRate = await this.getFeeRate([this.signer.publicKey, publicKey]);
                    SolanaSwapProgram.applyFeeRate(eraseTx, CUCosts.DATA_REMOVE, feeRate);
                    SolanaSwapProgram.applyFeeRateEnd(eraseTx, CUCosts.DATA_REMOVE, feeRate);

                    const [signature] = await this.sendAndConfirm([{tx: eraseTx, signers: []}], true);
                    console.log("[To BTC: Solana.GC] Previous data account erased: ", signature);
                }
                await this.removeDataAccount(publicKey);
            } catch (e) {}
        }
    }

    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

            if(!swapData.claimerAta.equals(ourAta)) {
                //Invalid ATA specified as our ATA
                return false;
            }
        }
        return swapData.claimer.equals(this.signer.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.signer.publicKey);
    }

    getATAOrNull(ata: PublicKey): Promise<Account> {
        return getAccount(this.signer.connection, ata).catch(e => {
            if(e instanceof TokenAccountNotFoundError) {
                return null;
            }
            throw e;
        });
    }

    async getBalance(token: TokenAddress, inContract: boolean): Promise<BN> {
        if(inContract) {
            const tokenAccount: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(this.signer.publicKey, token));
            if(tokenAccount==null) return null;
            return new BN(tokenAccount.amount.toString(10));
        } else {
            const ata: PublicKey = getAssociatedTokenAddressSync(token, this.signer.publicKey);
            const [ataAccount, balance] = await Promise.all<[Promise<Account>, Promise<number>]>([
                this.getATAOrNull(ata),
                (token!=null && token.equals(WSOL_ADDRESS)) ? this.signer.connection.getBalance(this.signer.publicKey) : Promise.resolve(null)
            ]);

            let ataExists: boolean = ataAccount!=null;
            let sum: BN = new BN(0);
            if(ataExists) {
                sum = sum.add(new BN(ataAccount.amount.toString()));
            }

            if(balance!=null) {
                let balanceLamports: BN = new BN(balance);
                if(!ataExists) balanceLamports = balanceLamports.sub(await this.getATARentExemptLamports());
                balanceLamports = balanceLamports.sub(await this.getCommitFee(null)); //Discount commit fee
                balanceLamports = balanceLamports.sub(new BN(5000)); //Discount refund fee
                if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
            }

            return sum;
        }
    }

    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {

        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        const escrowState: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            if(!data.correctPDA(escrowState)) {
                if(this.areWeOfferer(data)) {
                    if(this.isExpired(data)) {
                        return SwapCommitStatus.EXPIRED;
                    }
                }

                return SwapCommitStatus.NOT_COMMITED;
            }

            if(this.areWeOfferer(data)) {
                if (this.isExpired(data)) {
                    return SwapCommitStatus.REFUNDABLE;
                }
            }

            return SwapCommitStatus.COMMITED;
        } else {
            //Check if paid or what
            const signatures = await this.signer.connection.getSignaturesForAddress(escrowStateKey, {
                limit: 500
            });
            for(let sig of signatures) {
                const tx = await this.signer.connection.getTransaction(sig.signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0
                });
                if(tx.meta.err==null) {
                    const parsedEvents = this.eventParser.parseLogs(tx.meta.logMessages);

                    for(let _event of parsedEvents) {
                        if(_event.name==="ClaimEvent") {
                            const eventData: IdlEvents<SwapProgram>["ClaimEvent"] = _event.data as any;
                            if(eventData.sequence.eq(data.sequence)) return SwapCommitStatus.PAID;
                        }
                        if(_event.name==="RefundEvent") {
                            const eventData: IdlEvents<SwapProgram>["RefundEvent"] = _event.data as any;
                            if(eventData.sequence.eq(data.sequence)) {
                                if(this.isExpired(data)) {
                                    return SwapCommitStatus.EXPIRED;
                                }
                                return SwapCommitStatus.NOT_COMMITED;
                            }
                        }
                    }
                }
            }
            if(this.isExpired(data)) {
                return SwapCommitStatus.EXPIRED;
            }
            return SwapCommitStatus.NOT_COMMITED;
        }

    }

    async getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(paymentHash, "hex"));

        //Parallelize signature fetching
        const abortController = new AbortController();
        const signaturesPromise = this.signer.connection.getSignaturesForAddress(escrowStateKey, {
            limit: 500
        }).catch(e => {
            abortController.abort(e)
            return null;
        });

        const escrowState = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            return SwapCommitStatus.COMMITED;
        }

        abortController.signal.throwIfAborted();

        //Check if paid or what
        const signatures = await signaturesPromise;

        abortController.signal.throwIfAborted();

        for(let sig of signatures) {
            const tx = await this.signer.connection.getTransaction(sig.signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0
            });
            if(tx.meta.err==null) {
                const parsedEvents = this.eventParser.parseLogs(tx.meta.logMessages);

                for(let _event of parsedEvents) {
                    if(_event.name==="ClaimEvent") {
                        return SwapCommitStatus.PAID;
                    }
                    if(_event.name==="RefundEvent") {
                        return SwapCommitStatus.NOT_COMMITED;
                    }
                }
            }
        }

        return SwapCommitStatus.NOT_COMMITED;
    }

    private async getInitInstruction(swapData: SolanaSwapData, timeout: BN): Promise<TransactionInstruction> {

        let ix: TransactionInstruction;

        const claimerAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        if(swapData.payIn) {
            const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            ix = await this.program.methods
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

            ix = await this.program.methods
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


        return ix;
    }

    private async getClaimInitMessage(swapData: SolanaSwapData, prefix: string, timeout: string, feeRate?: string): Promise<Transaction> {

        if(!swapData.payIn) throw new Error("Invalid payIn value");

        const tx = new Transaction();
        tx.feePayer = swapData.offerer;

        const ix = await this.getInitInstruction(swapData, new BN(timeout));

        const hashArr = feeRate==null ? [] : feeRate.split("#");

        let computeBudget = CUCosts.INIT_PAY_IN;
        const instructions: TransactionInstruction[] = [];

        if(hashArr.length>1) {
            const arr = hashArr[1].split(";");
            if(arr.length>1) {
                const balance = new BN(arr[1]);
                if(balance.lt(swapData.amount)) {
                    computeBudget += CUCosts.WRAP_SOL;
                    if(arr[0]==="1") {
                        computeBudget += CUCosts.ATA_INIT;
                        instructions.push(createAssociatedTokenAccountInstruction(swapData.offerer, swapData.offererAta, swapData.offerer, swapData.token));
                    }
                    instructions.push(SystemProgram.transfer({
                        fromPubkey: swapData.offerer,
                        toPubkey: swapData.offererAta,
                        lamports: BigInt(swapData.amount.sub(balance).toString(10))
                    }));
                    instructions.push(createSyncNativeInstruction(swapData.offererAta));
                }
            }
        }

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        instructions.forEach(ix => tx.add(ix));
        tx.add(ix);
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return tx;

    }

    async getClaimInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");

        if(preFetchedBlockData!=null && Date.now()-preFetchedBlockData.timestamp>PREFETCHED_DATA_VALIDITY) preFetchedBlockData = null;

        const authPrefix = "claim_initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;

        const txToSign = await this.getClaimInitMessage(swapData, authPrefix, authTimeout.toString(), feeRate);

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.findLatestParsedBlock("finalized");

        txToSign.recentBlockhash = latestBlock.blockhash;
        txToSign.sign(this.signer.signer);

        const sig = txToSign.signatures.find(e => e.publicKey.equals(this.signer.signer.publicKey));

        return {
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: latestSlot+";"+sig.signature.toString("hex")
        };
    }

    async isValidClaimInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {

        if(prefix!=="claim_initialize") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.authGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        const [transactionSlot, signatureString] = signature.split(";");

        if(preFetchedData==null) preFetchedData = {};

        let getSlotPromise: Promise<number>;
        if(
            preFetchedData.latestSlot!=null &&
            preFetchedData.latestSlot.timestamp>Date.now()-SLOT_CACHE_TIME
        ) {
            getSlotPromise = Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/SLOT_TIME));
        } else {
            getSlotPromise = this.getCachedSlot("processed");
        }

        let getBlockhashPromise: Promise<string>;
        const txSlot = parseInt(transactionSlot);
        if(
            preFetchedData.transactionSlot!=null &&
            preFetchedData.transactionSlot.slot===txSlot
        ) {
            getBlockhashPromise = Promise.resolve(preFetchedData.transactionSlot.blockhash);
        } else {
            getBlockhashPromise = this.getParsedBlock(txSlot).then(val => val.blockhash);
        }

        const [latestSlot, blockhash] = await Promise.all([
            getSlotPromise,
            getBlockhashPromise
        ]);

        const lastValidTransactionSlot = parseInt(transactionSlot)+TX_SLOT_VALIDITY;
        // const latestSlot = await this.getCachedSlot("processed");
        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;
        if(slotsLeft<0) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        // const latestBlock = await this.getParsedBlock(parseInt(transactionSlot));

        const txToSign = await this.getClaimInitMessage(data, prefix, timeout, feeRate);

        txToSign.recentBlockhash = blockhash;
        txToSign.addSignature(data.claimer, Buffer.from(signatureString, "hex"));

        const valid = txToSign.verifySignatures(false);

        if(!valid) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Buffer.from(blockhash);

    }

    async getClaimInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        if(preFetchedData==null) preFetchedData = {};

        let getSlotPromise: Promise<number>;
        if(
            preFetchedData.latestSlot!=null &&
            preFetchedData.latestSlot.timestamp>Date.now()-SLOT_CACHE_TIME
        ) {
            getSlotPromise = Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/SLOT_TIME));
        } else {
            getSlotPromise = this.getCachedSlot("processed");
        }

        const latestSlot = await getSlotPromise;

        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;

        const now = Date.now();

        const expiry = Math.min(now + (slotsLeft*SLOT_TIME), (parseInt(timeout)-this.authGracePeriod)*1000);

        if(expiry<now) {
            return 0;
        }

        return expiry;
    }

    async isClaimInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        const latestSlot = await this.getCachedSlot("finalized");

        const slotsLeft = lastValidTransactionSlot-latestSlot+SLOT_BUFFER;

        if(slotsLeft<0) return true;

        if((parseInt(timeout)+this.authGracePeriod)*1000 < Date.now()) return true;

        return false;
    }

    private async getInitMessage(swapData: SolanaSwapData, prefix: string, timeout: string, feeRate?: string): Promise<Transaction> {

        if(swapData.payIn) throw new Error("Invalid payIn value");

        const tx = new Transaction();
        tx.feePayer = swapData.claimer;

        let result = await this.getInitInstruction(swapData, new BN(timeout));

        SolanaSwapProgram.applyFeeRate(tx, CUCosts.INIT, feeRate);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(swapData.claimer, swapData.claimerAta, swapData.claimer, swapData.token));
        tx.add(result);
        SolanaSwapProgram.applyFeeRateEnd(tx, CUCosts.INIT, feeRate);

        return tx;

    }

    async getInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");

        if(preFetchedBlockData!=null && Date.now()-preFetchedBlockData.timestamp>PREFETCHED_DATA_VALIDITY) preFetchedBlockData = null;

        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;

        const txToSign = await this.getInitMessage(swapData, authPrefix, authTimeout.toString(10), feeRate);

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.findLatestParsedBlock("finalized");
        txToSign.recentBlockhash = latestBlock.blockhash;
        txToSign.sign(this.signer.signer);

        const sig = txToSign.signatures.find(e => e.publicKey.equals(this.signer.signer.publicKey));

        return {
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: latestSlot+";"+sig.signature.toString("hex")
        };
    }

    async isValidInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {

        if(prefix!=="initialize") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.authGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        const swapWillExpireTooSoon = data.expiry.sub(currentTimestamp).lt(new BN(this.authGracePeriod).add(new BN(this.claimGracePeriod)));

        if (swapWillExpireTooSoon) {
            throw new SignatureVerificationError("Swap will expire too soon!");
        }

        const [transactionSlot, signatureString] = signature.split(";");

        if(preFetchedData==null) preFetchedData = {};

        let getSlotPromise: Promise<number>;
        if(
            preFetchedData.latestSlot!=null &&
            preFetchedData.latestSlot.timestamp>Date.now()-SLOT_CACHE_TIME
        ) {
            getSlotPromise = Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/SLOT_TIME));
        } else {
            getSlotPromise = this.getCachedSlot("processed");
        }

        let getBlockhashPromise: Promise<string>;
        const txSlot = parseInt(transactionSlot);
        if(
            preFetchedData.transactionSlot!=null &&
            preFetchedData.transactionSlot.slot===txSlot
        ) {
            getBlockhashPromise = Promise.resolve(preFetchedData.transactionSlot.blockhash);
        } else {
            getBlockhashPromise = this.getParsedBlock(txSlot).then(val => val.blockhash);
        }

        const [latestSlot, blockhash] = await Promise.all([
            getSlotPromise,
            getBlockhashPromise
        ]);

        const lastValidTransactionSlot = parseInt(transactionSlot)+TX_SLOT_VALIDITY;
        // const latestSlot = await this.getCachedSlot("processed");
        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;
        if(slotsLeft<0) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        // const latestBlock = await this.getParsedBlock(parseInt(transactionSlot));

        const txToSign = await this.getInitMessage(data, prefix, timeout, feeRate);

        //Check validity of recentBlockhash

        txToSign.recentBlockhash = blockhash;
        txToSign.addSignature(data.offerer, Buffer.from(signatureString, "hex"));

        const valid = txToSign.verifySignatures(false);

        if(!valid) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Buffer.from(blockhash);

    }

    async getInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        if(preFetchedData==null) preFetchedData = {};

        let getSlotPromise: Promise<number>;
        if(
            preFetchedData.latestSlot!=null &&
            preFetchedData.latestSlot.timestamp>Date.now()-SLOT_CACHE_TIME
        ) {
            getSlotPromise = Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/SLOT_TIME));
        } else {
            getSlotPromise = this.getCachedSlot("processed");
        }

        const latestSlot = await getSlotPromise;

        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;

        const now = Date.now();

        const expiry = Math.min(now + (slotsLeft*SLOT_TIME), (parseInt(timeout)-this.authGracePeriod)*1000);

        if(expiry<now) {
            return 0;
        }

        return expiry;
    }

    async isInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        const latestSlot = await this.getCachedSlot("finalized");

        const slotsLeft = lastValidTransactionSlot-latestSlot+SLOT_BUFFER;

        if(slotsLeft<0) return true;

        if((parseInt(timeout)+this.authGracePeriod)*1000 < Date.now()) return true;

        return false;
    }

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

        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        return messageBuffer;

    }

    getRefundSignature(swapData: SolanaSwapData, authorizationTimeout: number): Promise<{ prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");
        const authPrefix = "refund";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;

        const messageBuffer = this.getRefundMessage(swapData, authPrefix, authTimeout.toString(10));
        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    isValidRefundAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {

        if(prefix!=="refund") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.authGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = this.getRefundMessage(swapData, prefix, timeout);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, swapData.claimer.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Promise.resolve(messageBuffer);

    }

    getDataSignature(data: Buffer): Promise<string> {
        if(this.signer.signer==null) throw new Error("Unsupported");
        const buff = createHash("sha256").update(data).digest();
        const signature = sign.detached(buff, this.signer.signer.secretKey);

        return Promise.resolve(Buffer.from(signature).toString("hex"));
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        const hash = createHash("sha256").update(data).digest();
        return Promise.resolve(sign.detached.verify(hash, Buffer.from(signature, "hex"), new PublicKey(publicKey).toBuffer()));
    }

    isClaimable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeClaimer(data)) {
            return Promise.resolve(false);
        }

        if(this.isExpired(data)) {
            return Promise.resolve(false);
        }

        return this.isCommited(data);
    }

    async isCommited(swapData: SolanaSwapData): Promise<boolean> {
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account!=null) {
            return swapData.correctPDA(account);
        }

        return false;
    }

    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(0);
        if(this.areWeOfferer(data)) {
            currentTimestamp = new BN(Math.floor(Date.now()/1000)-this.refundGracePeriod);
        }
        if(this.areWeClaimer(data)) {
            currentTimestamp = new BN(Math.floor(Date.now()/1000)+this.claimGracePeriod);
        }
        return data.expiry.lt(currentTimestamp);
    }

    isRequestRefundable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeOfferer(data)) {
            return Promise.resolve(false);
        }

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-this.refundGracePeriod);

        const isExpired = data.expiry.lt(currentTimestamp);

        if(!isExpired) return Promise.resolve(false);

        return this.isCommited(data);
    }

    async getCommitedData(paymentHashHex: string): Promise<SolanaSwapData> {
        const paymentHash = Buffer.from(paymentHashHex, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));

        const data: IdlTypes<SwapProgram>["SwapData"] = account.data;

        if(account!=null) {
            return new SolanaSwapData(
                account.offerer,
                account.claimer,
                account.mint,
                data.amount,
                Buffer.from(data.hash).toString("hex"),
                data.sequence,
                data.expiry,
                data.nonce,
                data.confirmations,
                data.payOut,
                SwapTypeEnum.toNumber(data.kind),
                data.payIn,
                account.offererAta,
                account.claimerAta,
                account.securityDeposit,
                account.claimerBounty,
                null
            );
        }

        return null;
    }

    static typeToKind(type: ChainSwapType): number {
        switch (type) {
            case ChainSwapType.HTLC:
                return 0;
            case ChainSwapType.CHAIN:
                return 1;
            case ChainSwapType.CHAIN_NONCED:
                return 2;
            case ChainSwapType.CHAIN_TXID:
                return 3;
        }

        return null;
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
            type==null ? null : SolanaSwapProgram.typeToKind(type),
            payIn,
            offererKey==null ? null : payIn ? getAssociatedTokenAddressSync(token, offererKey) : PublicKey.default,
            claimerKey==null ? null : payOut ? getAssociatedTokenAddressSync(token, claimerKey) : PublicKey.default,
            securityDeposit,
            claimerBounty,
            null
        ));
    }

    confirmTransaction(rawTx: Buffer, signature: string, blockhash: string, lastValidBlockHeight: number, abortSignal?: AbortSignal, commitment?: Commitment) {
        return new Promise<void>((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }

            const abortController = new AbortController();

            const intervalWatchdog = setInterval(() => {
                this.signer.connection.getSignatureStatus(signature).then(status => {
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

            this.signer.connection.confirmTransaction({
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
                    tryWithRetries(() => this.signer.connection.getSignatureStatus(signature)).then(status => {
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
        if(result==null) result = await this.signer.connection.sendRawTransaction(data, options);
        return result;
    }

    async sendAndConfirm(txs: SolTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        let latestBlockData: {blockhash: string, lastValidBlockHeight: number} = null;

        for(let tx of txs) {
            if(tx.tx.recentBlockhash==null) {
                if(latestBlockData==null) latestBlockData = await tryWithRetries(() => this.signer.connection.getLatestBlockhash("confirmed"), this.retryPolicy);
                tx.tx.recentBlockhash = latestBlockData.blockhash;
                tx.tx.lastValidBlockHeight = latestBlockData.lastValidBlockHeight;
            }
            tx.tx.feePayer = this.signer.publicKey;
            if(this.cbkBeforeTxSigned!=null) await this.cbkBeforeTxSigned(tx);
            if(tx.signers!=null && tx.signers.length>0) for(let signer of tx.signers) tx.tx.sign(signer);
        }

        const signedTxs = await this.signer.wallet.signAllTransactions(txs.map(e => e.tx));

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


    async claimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, waitForConfirmation?, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {

        const result = await this.txsClaimWithSecret(swapData, secret, checkExpiry, initAta, feeRate);

        const [signature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return signature;

    }

    async txsClaimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: string, skipAtaCheck?: boolean): Promise<SolTx[]> {

        if(checkExpiry) {
            const expiryTimestamp = swapData.getExpiry();
            const currentTimestamp = Math.floor(Date.now() / 1000);

            console.log("[EVM.PaymentRequest] Expiry time: ", expiryTimestamp.toString());

            if (expiryTimestamp.sub(new BN(currentTimestamp)).lt(new BN(this.claimGracePeriod))) {
                console.error("[EVM.PaymentRequest] Not enough time to reliably pay the invoice");
                throw new SwapDataVerificationError("Not enough time to reliably pay the invoice");
            }
        }

        if(feeRate==null) feeRate = await this.getClaimFeeRate(swapData);

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        if(!skipAtaCheck) {
            if(swapData.isPayOut()) {
                const account = await tryWithRetries<Account>(() => this.getATAOrNull(swapData.claimerAta), this.retryPolicy);

                if(account==null) {
                    if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                    const generatedAtaAddress = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
                    if(!generatedAtaAddress.equals(swapData.claimerAta)) {
                        throw new SwapDataVerificationError("Invalid claimer token account address");
                    }
                    tx.add(
                        createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimer, swapData.token)
                    );
                }
            }
        }

        let ix: TransactionInstruction;
        let computeBudget: number;
        if(swapData.isPayOut()) {
            computeBudget = CUCosts.CLAIM_PAY_OUT;

            ix = await this.program.methods
                .claimerClaimPayOut(Buffer.from(secret, "hex"))
                .accounts({
                    signer: this.signer.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    claimerAta: swapData.claimerAta,
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    data: null
                })
                .instruction();
        } else {
            computeBudget = CUCosts.CLAIM;

            ix = await this.program.methods
                .claimerClaim(Buffer.from(secret, "hex"))
                .accounts({
                    signer: this.signer.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    claimerUserData: this.SwapUserVault(swapData.claimer, swapData.token),
                    data: null
                })
                .instruction();
        }

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        tx.add(ix);

        if(swapData.isPayOut()) {
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(swapData.claimerAta, this.signer.publicKey, this.signer.publicKey)
                );
            }
        }

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
        synchronizer?: RelaySynchronizer<any, SolTx, any>,
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

    async txsClaimWithTxData(
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolTx, any>,
        initAta?: boolean,
        storageAccHolder?: {storageAcc: PublicKey},
        feeRate?: string
    ): Promise<SolTx[] | null> {

        if(feeRate==null) feeRate = await this.getClaimFeeRate(swapData);

        let ataInitIx: TransactionInstruction;
        if(swapData.isPayOut()) {

            const account = await tryWithRetries<Account>(() => this.getATAOrNull(swapData.claimerAta), this.retryPolicy);

            if(account==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                const generatedAtaAddress = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
                if(!generatedAtaAddress.equals(swapData.claimerAta)) {
                    throw new SwapDataVerificationError("Invalid claimer token account address");
                }
                ataInitIx = createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimer, swapData.token);
            }
        }

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);

        const txs: SolTx[] = [];

        if(synchronizer==null) {
            if(commitedHeader==null) try {
                const result = await tryWithRetries(
                    () => this.btcRelay.retrieveLogAndBlockheight({
                        blockhash: tx.blockhash,
                        height: merkleProof.blockheight
                    }, blockheight+swapData.getConfirmations()-1),
                    this.retryPolicy
                );
                if(result!=null) commitedHeader = result.header;
            } catch (e) {
                console.error(e);
            }

            console.log("[Solana.Claim] Commited header retrieved: ", commitedHeader);

            if(commitedHeader==null) return null;
        } else {
            if(commitedHeader==null) {
                const requiredBlockheight = merkleProof.blockheight+swapData.getConfirmations()-1;

                const result = await tryWithRetries(
                    () => this.btcRelay.retrieveLogAndBlockheight({
                        blockhash: tx.blockhash,
                        height: merkleProof.blockheight
                    }, requiredBlockheight),
                    this.retryPolicy
                );

                if(result==null) {
                    //Need to synchronize
                    //TODO: We don't have to synchronize to tip, only to our required blockheight
                    const resp = await synchronizer.syncToLatestTxs();
                    console.log("BTC Relay not synchronized to required blockheight, synchronizing ourselves in "+resp.txs.length+" txs");
                    console.log("BTC Relay computed header map: ",resp.computedHeaderMap);
                    if(commitedHeader==null) {
                        //Retrieve computed header
                        commitedHeader = resp.computedHeaderMap[merkleProof.blockheight];
                    }

                    resp.txs.forEach(tx => {
                        txs.push(tx)
                    });
                } else {
                    commitedHeader = result.header;
                }
            }
        }

        console.log("[To BTC: Solana.Claim] Merkle proof computed: ", merkleProof);

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            Buffer.from(tx.hex, "hex")
        ]);

        console.log("[To BTC: Solana.Claim] Writing transaction data: ", writeData.toString("hex"));

        let txDataKey: Signer;
        if(this.signer.signer!=null) {
            txDataKey = this.SwapTxDataAlt(merkleProof.reversedTxId, this.signer.signer);
        } else {
            const secret = randomBytes(32);
            txDataKey = this.SwapTxDataAltBuffer(merkleProof.reversedTxId, secret);
        }

        if(storageAccHolder!=null) storageAccHolder.storageAcc = txDataKey.publicKey;

        const fetchedDataAccount: AccountInfo<Buffer> = await tryWithRetries<AccountInfo<Buffer>>(() => this.signer.connection.getAccountInfo(txDataKey.publicKey), this.retryPolicy);

        let pointer = 0;
        if(fetchedDataAccount==null) {
            const dataSize = writeData.length;
            const accountSize = 32+dataSize;
            const lamports = await tryWithRetries(() => this.signer.connection.getMinimumBalanceForRentExemption(accountSize), this.retryPolicy);

            const accIx = SystemProgram.createAccount({
                fromPubkey: this.signer.publicKey,
                newAccountPubkey: txDataKey.publicKey,
                lamports,
                space: accountSize,
                programId: this.program.programId
            });

            const initIx = await this.program.methods
                .initData()
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            const writeLen = Math.min(writeData.length-pointer, 420);

            const writeIx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, pointer+writeLen))
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length);

            pointer += writeLen;

            const initTx = new Transaction();
            initTx.feePayer = this.signer.publicKey;

            SolanaSwapProgram.applyFeeRate(initTx, CUCosts.DATA_CREATE_AND_WRITE, feeRate);
            initTx.add(accIx);
            initTx.add(initIx);
            initTx.add(writeIx);
            SolanaSwapProgram.applyFeeRateEnd(initTx, CUCosts.DATA_CREATE_AND_WRITE, feeRate);

            await this.saveDataAccount(txDataKey.publicKey);
            txs.push({
                tx: initTx,
                signers: [txDataKey]
            });
        }

        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const writeTx = new Transaction();
            writeTx.feePayer = this.signer.publicKey;

            const writeIx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, pointer+writeLen))
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .instruction();

            SolanaSwapProgram.applyFeeRate(writeTx, CUCosts.DATA_WRITE, feeRate);
            writeTx.add(writeIx);
            SolanaSwapProgram.applyFeeRateEnd(writeTx, CUCosts.DATA_WRITE, feeRate);

            txs.push({
                tx: writeTx,
                signers: []
            });

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length);

            pointer += writeLen;
        }


        console.log("[To BTC: Solana.Claim] Tx data written");

        const verifyIx = await this.btcRelay.createVerifyIx(merkleProof.reversedTxId, swapData.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader);
        let claimIx: TransactionInstruction;
        let computeBudget: number;
        if(swapData.isPayOut()) {
            computeBudget = CUCosts.CLAIM_ONCHAIN_PAY_OUT;
            claimIx = await this.program.methods
                .claimerClaimPayOut(Buffer.alloc(0))
                .accounts({
                    signer: this.signer.publicKey,
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
            computeBudget = CUCosts.CLAIM_ONCHAIN;
            claimIx = await this.program.methods
                .claimerClaim(Buffer.alloc(0))
                .accounts({
                    signer: this.signer.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    claimerUserData: this.SwapUserVault(swapData.claimer, swapData.token),
                    data: txDataKey.publicKey
                })
                .instruction();
        }

        const solanaTx = new Transaction();
        solanaTx.feePayer = this.signer.publicKey;

        solanaTx.add(verifyIx);
        SolanaSwapProgram.applyFeeRate(solanaTx, computeBudget, feeRate);
        if(ataInitIx!=null) solanaTx.add(ataInitIx);
        solanaTx.add(claimIx);
        SolanaSwapProgram.applyFeeRateEnd(solanaTx, computeBudget, feeRate);

        if(Utils.getTxSize(solanaTx, this.signer.publicKey)>1232) {
            //TX too large
            solanaTx.instructions.pop();
        }

        txs.push({
            tx: solanaTx,
            signers: []
        });

        if(swapData.isPayOut()) {
            if (swapData.token.equals(WSOL_ADDRESS) && swapData.claimer.equals(this.signer.publicKey)) {
                //Move to normal SOL
                const tx = new Transaction();
                tx.feePayer = this.signer.publicKey;
                SolanaSwapProgram.applyFeeRate(tx, CUCosts.ATA_CLOSE, feeRate);
                tx.add(
                    createCloseAccountInstruction(swapData.claimerAta, this.signer.publicKey, this.signer.publicKey)
                );
                SolanaSwapProgram.applyFeeRateEnd(tx, CUCosts.ATA_CLOSE, feeRate);
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

    async txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolTx[]> {

        if(check) {
            if(!(await tryWithRetries(() => this.isRequestRefundable(swapData), this.retryPolicy))) {
                throw new SwapDataVerificationError("Not refundable yet!");
            }
        }

        if(feeRate==null) feeRate = await this.getRefundFeeRate(swapData)

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        let ata: PublicKey = null;

        let ix: TransactionInstruction;

        let computeBudget: number;
        if(swapData.isPayIn()) {
            computeBudget = CUCosts.REFUND_PAY_OUT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);

            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
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
            computeBudget = CUCosts.REFUND;
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
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
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

    async txsRefundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolTx[]> {
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

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.claimer.toBuffer(),
            signature: signatureBuffer
        }));


        let ata: PublicKey = null;

        let ix: TransactionInstruction;
        let computeBudget: number;

        if(swapData.isPayIn()) {
            computeBudget = CUCosts.REFUND_PAY_OUT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
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
            computeBudget = CUCosts.REFUND;
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
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
                );
            }
        }
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

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

    async txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, skipChecks?: boolean, feeRate?: string): Promise<SolTx[]> {

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
        const ataIntermediary = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        const txs: SolTx[] = [];

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        if(feeRate==null || feeRate.split("#").length<2) {
            if(swapData.token.equals(WSOL_ADDRESS)) {
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

                    let computeBudget: number = CUCosts.WRAP_SOL;
                    //Need to wrap some more
                    const remainder = swapData.amount.sub(balance);
                    if(!accountExists) {
                        //Need to create account
                        computeBudget += CUCosts.ATA_INIT;
                        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
                        tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, swapData.token));
                    } else {
                        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
                    }
                    tx.add(SystemProgram.transfer({
                        fromPubkey: this.signer.publicKey,
                        toPubkey: ata,
                        lamports: remainder.toNumber()
                    }));
                    tx.add(createSyncNativeInstruction(ata));

                    SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

                    tx.recentBlockhash = block.blockhash;
                    tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;

                    txs.push({
                        tx,
                        signers: []
                    });
                }
            }
        }

        const tx = await this.getClaimInitMessage(swapData, prefix, timeout, feeRate);

        // const tx = new Transaction();
        // tx.feePayer = swapData.offerer;
        //
        // const ix = await this.getInitInstruction(swapData, new BN(timeout));
        //
        // SolanaSwapProgram.applyFeeRate(tx, CUCosts.INIT_PAY_IN, feeRate);
        // tx.add(ix);
        // SolanaSwapProgram.applyFeeRateEnd(tx, CUCosts.INIT_PAY_IN, feeRate);

        tx.recentBlockhash = block.blockhash;
        tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;
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

    async txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolTx[]> {

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

        // //Create claimerAta if it doesn't exist
        // const account = await tryWithRetries<Account>(() => this.getATAOrNull(claimerAta), this.retryPolicy);
        // if(account==null) {
        //     const tx = new Transaction();
        //     tx.feePayer = swapData.claimer;
        //     SolanaSwapProgram.applyFeeRate(tx, CUCosts.ATA_INIT, feeRate);
        //     tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, claimerAta, this.signer.publicKey, swapData.token));
        //     SolanaSwapProgram.applyFeeRateEnd(tx, CUCosts.ATA_INIT, feeRate);
        //     tx.recentBlockhash = block.blockhash;
        //     tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;
        //
        //     txns.push({tx, signers: []});
        // }

        const tx = new Transaction();
        tx.feePayer = swapData.claimer;

        const result = await this.getInitInstruction(swapData, new BN(timeout));

        SolanaSwapProgram.applyFeeRate(tx, CUCosts.INIT, feeRate);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, claimerAta, this.signer.publicKey, swapData.token));
        tx.add(result);
        SolanaSwapProgram.applyFeeRateEnd(tx, CUCosts.INIT, feeRate);

        tx.recentBlockhash = block.blockhash;
        tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;
        tx.addSignature(swapData.offerer, Buffer.from(signatureStr, "hex"));

        txns.push({tx, signers: []});

        return txns;

    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string[]> {

        const txsCommit = await this.txsInit(swapData, timeout, prefix, signature, null, skipChecks, feeRate);
        const txsClaim = await this.txsClaimWithSecret(swapData, secret, true, false, feeRate, true);

        return await this.sendAndConfirm(txsCommit.concat(txsClaim), waitForConfirmation, abortSignal);

    }

    getAddress(): string {
        return this.signer.publicKey.toBase58();
    }

    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

    async getIntermediaryReputation(address: string, token: PublicKey): Promise<IntermediaryReputationType> {

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

        return response;

    }

    async getIntermediaryBalance(address: string, token: PublicKey): Promise<BN> {
        const data: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(new PublicKey(address), token));

        if(data==null) return null;

        return data.amount;
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

    toTokenAddress(address: string): TokenAddress {
        return new PublicKey(address);
    }

    async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate(mutableAccounts);
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
                lamports: staticFee + ((BigInt(computeBudget || 200000)*cuPrice)/BigInt(1000000))
            }));
            return;
        }
        if(arr.length>1) {
            const cuPrice = BigInt(arr[0]);
            const bribeAddress = new PublicKey(arr[1]);
            tx.add(SystemProgram.transfer({
                fromPubkey: tx.feePayer,
                toPubkey: bribeAddress,
                lamports: (BigInt(computeBudget || 200000)*cuPrice)/BigInt(1000000)
            }));
            return;
        }
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: BigInt(feeRate)
        }));
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
            token!=null && offerer!=null && token.equals(WSOL_ADDRESS) ? this.getATAOrNull(getAssociatedTokenAddressSync(token, new PublicKey(offerer))) : Promise.resolve(null)
        ]).then(([feeRate, _account]) => {
            if(token!=null && offerer!=null && token.equals(WSOL_ADDRESS)) {
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

        // return Promise.all([
        //     this.getFeeRate(accounts),
        //     this.getATAOrNull(getAssociatedTokenAddressSync(token, claimerPubkey))
        // ]).then(([feeRate, acc]) => {
        //     if(acc==null) return feeRate+"#1";
        //     return feeRate;
        // });
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

        const accounts: PublicKey[] = [this.signer.publicKey];
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

    private getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(2039280));
    }

    async getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-ESCROW_STATE_RENT_EXEMPT+5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? CUCosts.CLAIM_PAY_OUT : CUCosts.CLAIM
        ) : (
            swapData.payOut ? CUCosts.CLAIM_ONCHAIN_PAY_OUT : CUCosts.CLAIM_ONCHAIN
        );
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(-ESCROW_STATE_RENT_EXEMPT+5000).add(priorityLamports);
    }

    async getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? CUCosts.CLAIM_PAY_OUT : CUCosts.CLAIM
        ) : (
            swapData.payOut ? CUCosts.CLAIM_ONCHAIN_PAY_OUT : CUCosts.CLAIM_ONCHAIN
        );
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(5000).add(priorityLamports);
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

        const computeBudget = swapData.payIn ? CUCosts.INIT_PAY_IN : CUCosts.INIT;
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

        const computeBudget = swapData.payIn ? CUCosts.REFUND_PAY_OUT : CUCosts.REFUND;
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

        const computeBudget = swapData.payIn ? CUCosts.REFUND_PAY_OUT : CUCosts.REFUND;
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000)).add(new BN(SolanaSwapProgram.getStaticFee(feeRate)));

        return new BN(10000).add(priorityLamports);
    }

    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.claimer = this.signer.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerAta = getAssociatedTokenAddressSync(swapData.token, this.signer.publicKey);
    }

    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.signer.publicKey;
        swapData.offererAta = getAssociatedTokenAddressSync(swapData.token, this.signer.publicKey);
        swapData.payIn = true;
    }

    getNativeCurrencyAddress(): TokenAddress {
        return WSOL_ADDRESS;
    }

    async withdraw(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsWithdraw(token, amount, feeRate);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.signer.publicKey);

        feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, ata, this.SwapUserVault(this.signer.publicKey, token), this.SwapVault(token)]);

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        let computeBudget = CUCosts.WITHDRAW;

        const account = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);
        if(account==null) {
            computeBudget += CUCosts.ATA_INIT;
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            tx.add(
                createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token)
            );
        } else {
            SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        }

        let ix = await this.program.methods
            .withdraw(new BN(amount))
            .accounts({
                signer: this.signer.publicKey,
                signerAta: ata,
                userData: this.SwapUserVault(this.signer.publicKey, token),
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: token,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        tx.add(ix);

        if (WSOL_ADDRESS.equals(token)) {
            //Move to normal SOL
            tx.add(
                createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
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
    async txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.signer.publicKey);
        
        feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, ata, this.SwapUserVault(this.signer.publicKey, token), this.SwapVault(token)]);

        let computeBudget = CUCosts.DEPOSIT;
        const ixs: TransactionInstruction[] = [];

        if(WSOL_ADDRESS.equals(token)) {
            let accountExists: boolean = false;
            let balance: BN = new BN(0);

            const ataAcc = await tryWithRetries<Account>(() => this.getATAOrNull(ata), this.retryPolicy);
            if(ataAcc!=null) {
                accountExists = true;
                balance = balance.add(new BN(ataAcc.amount.toString()));
            }
            if(balance.lt(amount)) {
                computeBudget += CUCosts.WRAP_SOL;
                const remainder = amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    computeBudget += CUCosts.ATA_INIT;
                    ixs.push(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token));
                }
                ixs.push(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                ixs.push(createSyncNativeInstruction(ata));
            }
        }

        const depositIx = await this.program.methods
            .deposit(new BN(amount))
            .accounts({
                signer: this.signer.publicKey,
                signerAta: ata,
                userData: this.SwapUserVault(this.signer.publicKey, token),
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: token,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
        ixs.forEach(ix => tx.add(ix));
        tx.add(depositIx);
        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx,
            signers: []
        }]
    }
    async transfer(token: PublicKey, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress, feeRate);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsTransfer(token: PublicKey, amount: BN, dstAddress: string, feeRate?: string): Promise<SolTx[]> {
        const recipient = new PublicKey(dstAddress);

        let computeBudget = CUCosts.TRANSFER;

        if(WSOL_ADDRESS.equals(token)) {
            const wsolAta = getAssociatedTokenAddressSync(token, this.signer.publicKey, false);
            const account = await tryWithRetries<Account>(() => this.getATAOrNull(wsolAta), this.retryPolicy);

            const tx = new Transaction();
            tx.feePayer = this.signer.publicKey;

            if(account!=null) {
                feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, recipient, wsolAta]);
                computeBudget += CUCosts.ATA_CLOSE;
                SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
                //Unwrap
                tx.add(
                    createCloseAccountInstruction(wsolAta, this.signer.publicKey, this.signer.publicKey)
                );
            } else {
                feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, recipient]);
                SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);
            }

            tx.add(
                SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: recipient,
                    lamports: BigInt(amount.toString(10))
                })
            );

            SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

            return [{
                tx,
                signers: []
            }];
        }

        const ata = await getAssociatedTokenAddress(token, this.signer.publicKey);

        if(!PublicKey.isOnCurve(new PublicKey(dstAddress))) {
            throw new Error("Recipient must be a valid public key");
        }

        const dstAta = getAssociatedTokenAddressSync(token, new PublicKey(dstAddress), false);

        feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, ata, dstAta]);

        const tx = new Transaction();
        tx.feePayer = this.signer.publicKey;

        SolanaSwapProgram.applyFeeRate(tx, computeBudget, feeRate);

        const account = await tryWithRetries<Account>(() => this.getATAOrNull(dstAta), this.retryPolicy);
        console.log("Account ATA: ", account);
        if(account==null) {
            tx.add(
                createAssociatedTokenAccountInstruction(this.signer.publicKey, dstAta, new PublicKey(dstAddress), token)
            );
        }

        const ix = createTransferInstruction(ata, dstAta, this.signer.publicKey, BigInt(amount.toString(10)));
        tx.add(ix);

        SolanaSwapProgram.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx: tx,
            signers: []
        }];
    }
    serializeTx(tx: SolTx): Promise<string> {
        return Promise.resolve(JSON.stringify({
            tx: tx.tx.serialize().toString("hex"),
            signers: tx.signers.map(e => Buffer.from(e.secretKey).toString("hex")),
            lastValidBlockheight: tx.tx.lastValidBlockHeight
        }));
    }
    deserializeTx(txData: string): Promise<SolTx> {
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
        const parsedTx: SolTx = await this.deserializeTx(tx);
        const txReceipt = await this.signer.connection.getTransaction(bs58.encode(parsedTx.tx.signature), {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(txReceipt==null) {
            const currentBlockheight = await this.signer.connection.getBlockHeight("processed");
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
        const txReceipt = await this.signer.connection.getTransaction(txId, {
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

    cbkBeforeTxSigned: (tx: SolTx) => Promise<void>;

    onBeforeTxSigned(callback: (tx: SolTx) => Promise<void>): void {
        this.cbkBeforeTxSigned = callback;
    }
    offBeforeTxSigned(callback: (tx: SolTx) => Promise<void>): boolean {
        this.cbkBeforeTxSigned = null;
        return true;
    }

    cbkSendTransaction: (tx: Buffer, options?: SendOptions) => Promise<string>;

    onSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): void {
        this.cbkSendTransaction = callback;
    }
    offSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): boolean {
        this.cbkSendTransaction = null;
        return true;
    }

}
