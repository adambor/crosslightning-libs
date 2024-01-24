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
    Signer,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
    Transaction,
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
    getAssociatedTokenAddress, createTransferInstruction
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

export type SolanaRetryPolicy = {
    maxRetries?: number,
    delay?: number,
    exponential?: boolean
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

    async getBalance(token: TokenAddress, inContract: boolean): Promise<BN> {
        if(inContract) {
            const tokenAccount: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(this.signer.publicKey, token));
            if(tokenAccount==null) return null;
            return new BN(tokenAccount.amount.toString(10));
        } else {
            const ata: PublicKey = getAssociatedTokenAddressSync(token, this.signer.publicKey);
            let ataExists: boolean = false;
            let sum: BN = new BN(0);
            try {
                const account = await getAccount(this.signer.connection, ata);
                ataExists = true;
                sum = sum.add(new BN(account.amount.toString()));
            } catch (e) {
                if(!(e instanceof TokenAccountNotFoundError)) {
                    throw e;
                }
            }

            if(token!=null && token.equals(WSOL_ADDRESS)) {
                let balanceLamports: BN = new BN(await this.signer.connection.getBalance(this.signer.publicKey));
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
                const tx = await this.signer.connection.getTransaction(sig.signature);
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
        const signaturesPromise = this.signer.connection.getSignaturesForAddress(escrowStateKey, {
            limit: 500
        });

        const escrowState = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            return SwapCommitStatus.COMMITED;
        }

        //Check if paid or what
        const signatures = await signaturesPromise;

        for(let sig of signatures) {
            const tx = await this.signer.connection.getTransaction(sig.signature);
            if(tx.meta.err==null) {
                const instructions = Utils.decodeInstructions(tx.transaction.message);
                for(let ix of instructions) {
                    if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut") {
                        return SwapCommitStatus.PAID;
                    }
                    if(ix.name==="offererRefund" || ix.name==="offererRefundPayIn") {
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

        const ix = await this.getInitInstruction(swapData, new BN(timeout));

        if(feeRate!=null) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: parseInt(feeRate)
            }));
        }
        tx.add(ix);
        tx.feePayer = swapData.offerer;

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

        let result = await this.getInitInstruction(swapData, new BN(timeout));

        if(feeRate!=null) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: parseInt(feeRate)
            }));
        }
        tx.add(result);
        tx.feePayer = swapData.claimer;

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

    confirmTransaction(signature: string, blockhash: string, lastValidBlockHeight: number, abortSignal?: AbortSignal, commitment?: Commitment) {
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
            }, 5000);
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
                        reject(err);
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

    async sendAndConfirm(txs: SolTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        let latestBlockData: {blockhash: string, lastValidBlockHeight: number} = null;

        for(let tx of txs) {
            if(tx.tx.recentBlockhash==null) {
                if(latestBlockData==null) latestBlockData = await tryWithRetries(() => this.signer.connection.getLatestBlockhash("confirmed"), this.retryPolicy);
                tx.tx.recentBlockhash = latestBlockData.blockhash;
                tx.tx.lastValidBlockHeight = latestBlockData.lastValidBlockHeight;
            }
            tx.tx.feePayer = this.signer.publicKey;
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
                const txResult = await tryWithRetries(() => this.signer.connection.sendRawTransaction(tx.serialize(), options), this.retryPolicy);
                console.log("Send signed TX: ", txResult);
                if(waitForConfirmation) {
                    promises.push(this.confirmTransaction(
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
                const txResult = await tryWithRetries(() => this.signer.connection.sendRawTransaction(tx.serialize(), options), this.retryPolicy);
                console.log("Send signed TX: ", txResult);
                await this.confirmTransaction(
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
                const txResult = await tryWithRetries(() => this.signer.connection.sendRawTransaction(lastTx.serialize(), options), this.retryPolicy);
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

        const tx = new Transaction();

        if(!skipAtaCheck) {
            if(swapData.isPayOut()) {
                const account = await tryWithRetries<Account>(async () => {
                    try {
                        return await getAccount(this.signer.connection, swapData.claimerAta);
                    } catch (e) {
                        if(e instanceof TokenAccountNotFoundError) {
                            return null;
                        }
                        throw e;
                    }
                }, this.retryPolicy);

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
        if(swapData.isPayOut()) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 75000,
            }));

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
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 25000,
            }));

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

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getClaimFeeRate(swapData)))
        }));
        tx.add(ix);

        if(swapData.isPayOut()) {
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    createCloseAccountInstruction(swapData.claimerAta, this.signer.publicKey, this.signer.publicKey)
                );
            }
        }

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

        const computedFeeRate = parseInt(feeRate || (await this.getClaimFeeRate(swapData)));

        let ataInitIx: TransactionInstruction;
        if(swapData.isPayOut()) {

            const account = await tryWithRetries<Account>(async () => {
                try {
                    return await getAccount(this.signer.connection, swapData.claimerAta);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

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
                commitedHeader = result.header;
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

                    const useFeeRate = resp.startForkId==null ? await this.btcRelay.getMainFeeRate() : await this.btcRelay.getForkFeeRate(resp.startForkId);

                    resp.txs.forEach(tx => {
                        tx.tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: parseInt(useFeeRate)
                        }));
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
            initTx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: computedFeeRate
            }));
            initTx.add(accIx);
            initTx.add(initIx);
            initTx.add(writeIx);

            await this.saveDataAccount(txDataKey.publicKey);
            txs.push({
                tx: initTx,
                signers: [txDataKey]
            });
        }

        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const writeTx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, pointer+writeLen))
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .transaction();

            writeTx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: computedFeeRate
            }));

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
        if(swapData.isPayOut()) {
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
        solanaTx.add(verifyIx);
        if(ataInitIx!=null) solanaTx.add(ataInitIx);
        solanaTx.add(claimIx);

        //Add compute budget
        solanaTx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: computedFeeRate
        }));

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
                tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                    units: 50000,
                }));
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: computedFeeRate
                }));
                tx.add(
                    createCloseAccountInstruction(swapData.claimerAta, this.signer.publicKey, this.signer.publicKey)
                );
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

        const tx = new Transaction();

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getRefundFeeRate(swapData)))
        }));

        let ata: PublicKey = null;

        let ix: TransactionInstruction;

        if(swapData.isPayIn()) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));

            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(async () => {
                try {
                    return await getAccount(this.signer.connection, ata);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

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
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 25000,
            }));

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

        const tx = new Transaction();

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.claimer.toBuffer(),
            signature: signatureBuffer
        }));

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000,
        }));

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getRefundFeeRate(swapData)))
        }));

        let ata: PublicKey = null;

        let ix: TransactionInstruction;

        if(swapData.isPayIn()) {
            ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<Account>(async () => {
                try {
                    return await getAccount(this.signer.connection, ata);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

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

        const computedFeeRate = feeRate==null ? null : parseInt(feeRate);

        const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);
        const ataIntermediary = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        const txs: SolTx[] = [];

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        if(swapData.token.equals(WSOL_ADDRESS)) {
            let balance = new BN(0);
            let accountExists = false;
            try {
                const ataAcc = await tryWithRetries<Account>(async () => {
                    try {
                        return await getAccount(this.signer.connection, ata);
                    } catch (e) {
                        if(e instanceof TokenAccountNotFoundError) {
                            return null;
                        }
                        throw e;
                    }
                }, this.retryPolicy);

                if(ataAcc!=null) {
                    accountExists = true;
                    balance = balance.add(new BN(ataAcc.amount.toString()));
                }
            } catch (e) {}
            if(balance.lt(swapData.amount)) {
                const tx = new Transaction();

                if(computedFeeRate!=null) {
                    tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                        units: 100000,
                    }));
                    tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: computedFeeRate
                    }));
                }

                //Need to wrap some more
                const remainder = swapData.amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, swapData.token));
                }
                tx.add(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                tx.add(createSyncNativeInstruction(ata));
                tx.feePayer = swapData.offerer;
                tx.recentBlockhash = block.blockhash;
                tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;

                txs.push({
                    tx,
                    signers: []
                });
            }

        }

        const tx = new Transaction();

        const ix = await this.getInitInstruction(swapData, new BN(timeout));

        if(computedFeeRate!=null) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: computedFeeRate
            }));
        }
        tx.add(ix);

        tx.feePayer = swapData.offerer;
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

        const _feeRate: number = feeRate==null ? null : parseInt(feeRate);

        const txns: {tx: Transaction, signers: Signer[]}[] = [];

        const claimerAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        //Create claimerAta if it doesn't exist
        const account = await tryWithRetries<Account>(async () => {
            try {
                return await getAccount(this.signer.connection, claimerAta);
            } catch (e) {
                if(e instanceof TokenAccountNotFoundError) {
                    return null;
                }
                throw e;
            }
        }, this.retryPolicy);
        if(account==null) {
            const tx = new Transaction();
            if(_feeRate!=null) {
                tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                    units: 50000,
                }));
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: _feeRate
                }));
            }
            tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, claimerAta, this.signer.publicKey, swapData.token));
            tx.feePayer = swapData.claimer;
            tx.recentBlockhash = block.blockhash;
            tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;

            txns.push({tx, signers: []});
        }

        const tx = new Transaction();

        const result = await this.getInitInstruction(swapData, new BN(timeout));

        if(_feeRate!=null) {
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: _feeRate
            }));
        }
        tx.add(result);

        tx.feePayer = swapData.claimer;
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

    toTokenAddress(address: string): TokenAddress {
        return new PublicKey(address);
    }

    async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate(mutableAccounts).then(e => e.toString(10));
    }

    async getInitPayInFeeRate(offerer: string, claimer: string, token: PublicKey, paymentHash?: string): Promise<string> {

        const offererATA = await getAssociatedTokenAddress(token, new PublicKey(offerer));
        const userData = this.SwapUserVault(new PublicKey(claimer), token);
        const vault = this.SwapVault(token);

        const accounts = [
            new PublicKey(offerer),
            offererATA,
            userData,
            vault
        ];

        if(paymentHash!=null) {
            const escrowState = this.SwapEscrowState(Buffer.from(paymentHash, "hex"));
            accounts.push(escrowState);
        }

        return await this.getFeeRate(accounts);

    }

    async getInitFeeRate(offerer: string, claimer: string, token: PublicKey, paymentHash?: string): Promise<string> {

        const userData = this.SwapUserVault(new PublicKey(offerer), token);

        const accounts = [
            new PublicKey(claimer),
            userData
        ];
        if(paymentHash!=null) {
            const escrowState = this.SwapEscrowState(Buffer.from(paymentHash, "hex"));
            accounts.push(escrowState);
        }

        return await this.getFeeRate(accounts);

    }

    async getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {

        let accounts: PublicKey[] = [];
        if(swapData.payIn) {
            const vault = this.SwapVault(swapData.token);

            accounts = [
                swapData.offerer,
                swapData.claimer,
                vault
            ];

            if(swapData.offererAta!=null) {
                accounts.push(swapData.offererAta);
            }
        } else {
            const userData = this.SwapUserVault(swapData.offerer, swapData.token);

            accounts = [
                swapData.offerer,
                swapData.claimer,
                userData
            ];
        }

        if(swapData.paymentHash!=null) {
            accounts.push(this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));
        }

        return await this.getFeeRate(accounts);

    }

    async getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {

        let accounts: PublicKey[] = [];
        if(swapData.payOut) {
            const vault = this.SwapVault(swapData.token);

            accounts = [
                this.signer.publicKey,
                swapData.payIn ? swapData.offerer : swapData.claimer,
                vault
            ];

            if(swapData.claimerAta!=null) {
                accounts.push(swapData.claimerAta);
            }
        } else {
            const userData = this.SwapUserVault(swapData.claimer, swapData.token);

            accounts = [
                this.signer.publicKey,
                swapData.payIn ? swapData.offerer : swapData.claimer,
                userData
            ];
        }

        if(swapData.paymentHash!=null) {
            accounts.push(this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));
        }

        return await this.getFeeRate(accounts);
    }

    private getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(2039280));
    }

    async getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-ESCROW_STATE_RENT_EXEMPT+5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? 75000 : 25000
        ) : 400000;
        const priorityMicroLamports = new BN(feeRate).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

        return new BN(-ESCROW_STATE_RENT_EXEMPT+5000).add(priorityLamports);
    }

    async getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        const computeBudget = swapData.getType()===ChainSwapType.HTLC ? (
            swapData.payOut ? 75000 : 25000
        ) : 400000;
        const priorityMicroLamports = new BN(feeRate).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

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

        const computeBudget = swapData.payIn ? 100000 : 100000 + 50000;
        const baseFee = swapData.payIn ? 10000 : 10000 + 5000;
        const priorityMicroLamports = new BN(feeRate).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

        return new BN(ESCROW_STATE_RENT_EXEMPT+baseFee).add(priorityLamports);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-ESCROW_STATE_RENT_EXEMPT+10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? 100000 : 25000;
        const priorityMicroLamports = new BN(feeRate).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

        return new BN(-ESCROW_STATE_RENT_EXEMPT+10000).add(priorityLamports);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRawRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? 100000 : 25000;
        const priorityMicroLamports = new BN(feeRate).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

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

        const computeBudget = 100000;
        feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, ata, this.SwapUserVault(this.signer.publicKey, token), this.SwapVault(token)]);

        const tx = new Transaction();

        const account = await tryWithRetries<Account>(async () => {
            try {
                return await getAccount(this.signer.connection, ata);
            } catch (e) {
                if(e instanceof TokenAccountNotFoundError) {
                    return null;
                }
                throw e;
            }
        }, this.retryPolicy);
        if(account==null) {
            tx.add(
                createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token)
            );
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

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate)
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget
        }));

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

        const tx = new Transaction();

        const computeBudget = 100000;
        feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, ata, this.SwapUserVault(this.signer.publicKey, token), this.SwapVault(token)]);

        if(WSOL_ADDRESS.equals(token)) {
            let accountExists: boolean = false;
            let balance: BN = new BN(0);

            const ataAcc = await tryWithRetries<Account>(async () => {
                try {
                    return await getAccount(this.signer.connection, ata);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);
            if(ataAcc!=null) {
                accountExists = true;
                balance = balance.add(new BN(ataAcc.amount.toString()));
            }
            if(balance.lt(amount)) {
                const remainder = amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    tx.add(createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token));
                }
                tx.add(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                tx.add(createSyncNativeInstruction(ata));
            }
        }

        let depositIx = await this.program.methods
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

        tx.add(depositIx);

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate)
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget
        }));

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

        const computeBudget = 100000;

        if(WSOL_ADDRESS.equals(token)) {
            const wsolAta = getAssociatedTokenAddressSync(token, this.signer.publicKey, false);
            const account = await tryWithRetries<Account>(async () => {
                try {
                    return await getAccount(this.signer.connection, wsolAta);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

            const tx = new Transaction();
            if(account!=null) {
                feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, recipient, wsolAta]);
                //Unwrap
                tx.add(
                    createCloseAccountInstruction(wsolAta, this.signer.publicKey, this.signer.publicKey)
                );
            } else {
                feeRate = feeRate || await this.getFeeRate([this.signer.publicKey, recipient]);
            }

            tx.add(
                SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: recipient,
                    lamports: BigInt(amount.toString(10))
                })
            );

            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: parseInt(feeRate)
            }));
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: computeBudget
            }));

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

        const account = await tryWithRetries<Account>(async () => {
            try {
                return await getAccount(this.signer.connection, dstAta);
            } catch (e) {
                if(e instanceof TokenAccountNotFoundError) {
                    return null;
                }
                throw e;
            }
        }, this.retryPolicy);
        console.log("Account ATA: ", account);
        if(account==null) {
            tx.add(
                createAssociatedTokenAccountInstruction(this.signer.publicKey, dstAta, new PublicKey(dstAddress), token)
            );
        }

        const ix = createTransferInstruction(ata, dstAta, this.signer.publicKey, BigInt(amount.toString(10)));
        tx.add(ix);

        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate)
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget
        }));

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
        const txReceipt = await this.signer.connection.getTransaction(bs58.encode(parsedTx.tx.signature));
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
        const txReceipt = await this.signer.connection.getTransaction(txId);
        if(txReceipt==null) return "not_found";
        if(txReceipt.meta.err) return "reverted";
        return "success";

    }
    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void {
    }
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean {
        return true;
    }

}
