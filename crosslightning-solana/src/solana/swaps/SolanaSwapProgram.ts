import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, BorshCoder, EventParser, Program} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
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
import * as SplToken from "@solana/spl-token";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import {programIdl} from "./programIdl";
import {IStorageManager, ISwapNonce, SwapContract, ChainSwapType, TokenAddress, IntermediaryReputationType,
    SwapCommitStatus, SignatureVerificationError, CannotInitializeATAError, SwapDataVerificationError} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {RelaySynchronizer, StorageObject} from "crosslightning-base/dist";
import Utils from "./Utils";
import * as bs58 from "bs58";
import {tryWithRetries} from "../../utils/RetryUtils";
import {defaultAccountStateInstructionData, TokenAccountNotFoundError} from "@solana/spl-token";

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

const SLOT_CACHE_SLOTS = 4;
const SLOT_CACHE_TIME = SLOT_CACHE_SLOTS*SLOT_TIME;

const PREFETCHED_DATA_VALIDITY = 5000;

export type SolanaRetryPolicy = {
    maxRetries?: number,
    delay?: number,
    exponential?: boolean
}

export class SolanaSwapProgram implements SwapContract<SolanaSwapData, SolTx> {

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

    private async getCachedSlot(commitment: Commitment): Promise<number> {

        if(this.slotCache[commitment]!=null && Date.now()-this.slotCache[commitment].timestamp<SLOT_CACHE_TIME) {
            return this.slotCache[commitment].slot;
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
    readonly program: Program;
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

    constructor(signer: AnchorProvider & {signer?: Signer}, btcRelay: SolanaBtcRelay<any>, storage: IStorageManager<StoredDataAccount>, programAddress?: string, retryPolicy?: SolanaRetryPolicy) {
        this.signer = signer;
        this.program = new Program(programIdl as any, programAddress || programIdl.metadata.address, signer);
        this.coder = new BorshCoder(programIdl as any);
        this.eventParser = new EventParser(this.program.programId, this.coder);

        this.btcRelay = btcRelay;

        this.storage = storage;

        this.SwapVaultAuthority = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];

        this.retryPolicy = retryPolicy;
    }

    async preFetchBlockDataForSignatures(): Promise<{
        block: ParsedAccountsModeBlockResponse,
        slot: number,
        timestamp: number
    }> {
        const latestParsedBlock: any = await this.findLatestParsedBlock("finalized");
        latestParsedBlock.timestamp = Date.now();
        return latestParsedBlock;
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
                const fetchedDataAccount: any = await this.signer.connection.getAccountInfo(publicKey);
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
            const ourAta = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

            if(!swapData.claimerTokenAccount.equals(ourAta)) {
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
            const tokenAccount: any = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(this.signer.publicKey, token));
            if(tokenAccount==null) return null;
            return new BN(tokenAccount.amount.toString(10));
        } else {
            const ata: PublicKey = SplToken.getAssociatedTokenAddressSync(token, this.signer.publicKey);
            let ataExists: boolean = false;
            let sum: BN = new BN(0);
            try {
                const account = await SplToken.getAccount(this.signer.connection, ata);
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
                balanceLamports = balanceLamports.sub(await this.getCommitFee()); //Discount commit fee
                balanceLamports = balanceLamports.sub(new BN(5000)); //Discount refund fee
                if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
            }

            return sum;
        }
    }

    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {

        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        const escrowState: any = await this.program.account.escrowState.fetchNullable(escrowStateKey);
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
                    const instructions = Utils.decodeInstructions(tx.transaction.message);
                    for(let ix of instructions) {
                        if(ix==null) continue;
                        if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut" || ix.name==="claimerClaimWithExtData" || ix.name==="claimerClaimPayOutWithExtData") {
                            return SwapCommitStatus.PAID;
                        }
                        if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                            if(this.isExpired(data)) {
                                return SwapCommitStatus.EXPIRED;
                            }
                            return SwapCommitStatus.NOT_COMMITED;
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
                    if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                        return SwapCommitStatus.NOT_COMMITED;
                    }
                }
            }
        }

        return SwapCommitStatus.NOT_COMMITED;
    }

    private async getClaimInitMessage(swapData: SolanaSwapData, nonce: number, prefix: string, timeout: string, feeRate?: string): Promise<Transaction> {

        const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);
        const ataClaimer = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const tx = new Transaction();

        const ix = await this.program.methods
            .offererInitializePayIn(
                swapData.amount,
                swapData.expiry,
                paymentHash,
                new BN(swapData.kind),
                new BN(swapData.confirmations),
                new BN(timeout),
                swapData.nonce,
                swapData.payOut,
                Buffer.alloc(32, 0)
            )
            .accounts({
                offerer: swapData.offerer,
                initializerDepositTokenAccount: ata,
                claimer: swapData.claimer,
                claimerTokenAccount: ataClaimer,
                userData: this.SwapUserVault(swapData.claimer, swapData.token),
                escrowState: this.SwapEscrowState(paymentHash),
                vault: this.SwapVault(swapData.token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: swapData.token,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

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

    async getClaimInitSignature(swapData: SolanaSwapData, nonce: ISwapNonce, authorizationTimeout: number, preFetchedBlockData?: {
        block: ParsedAccountsModeBlockResponse,
        slot: number,
        timestamp: number
    }, feeRate?: string): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");

        if(preFetchedBlockData!=null && Date.now()-preFetchedBlockData.timestamp>PREFETCHED_DATA_VALIDITY) preFetchedBlockData = null;

        const authPrefix = "claim_initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const useNonce = nonce.getClaimNonce(swapData.token.toBase58())+1;

        const txToSign = await this.getClaimInitMessage(swapData, useNonce, authPrefix, authTimeout.toString(), feeRate);

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.findLatestParsedBlock("finalized");

        txToSign.recentBlockhash = latestBlock.blockhash;
        txToSign.sign(this.signer.signer);

        const sig = txToSign.signatures.find(e => e.publicKey.equals(this.signer.signer.publicKey));

        return {
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: latestSlot+";"+sig.signature.toString("hex")
        };
    }

    async isValidClaimInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, feeRate?: string): Promise<Buffer> {

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

        const [latestSlot, transactionBlock] = await Promise.all([
            this.getCachedSlot("processed"),
            this.getParsedBlock(parseInt(transactionSlot))
        ]);

        const lastValidTransactionSlot = parseInt(transactionSlot)+TX_SLOT_VALIDITY;
        // const latestSlot = await this.getCachedSlot("processed");
        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;
        if(slotsLeft<0) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        // const latestBlock = await this.getParsedBlock(parseInt(transactionSlot));

        const txToSign = await this.getClaimInitMessage(data, nonce, prefix, timeout, feeRate);

        txToSign.recentBlockhash = transactionBlock.blockhash;
        txToSign.addSignature(data.claimer, Buffer.from(signatureString, "hex"));

        const valid = txToSign.verifySignatures(false);

        if(!valid) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Buffer.from(transactionBlock.blockhash);

    }

    async getClaimInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<number> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        const latestSlot = await this.getCachedSlot("processed");

        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;

        const now = Date.now();

        const expiry = Math.min(now + (slotsLeft*SLOT_TIME), (parseInt(timeout)-this.authGracePeriod)*1000);

        if(expiry<now) {
            return 0;
        }

        return expiry;
    }

    async isClaimInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<boolean> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        const latestSlot = await this.getCachedSlot("finalized");

        const slotsLeft = lastValidTransactionSlot-latestSlot+SLOT_BUFFER;

        if(slotsLeft<0) return true;

        if((parseInt(timeout)+this.authGracePeriod)*1000 < Date.now()) return true;

        return false;
    }

    private async getInitMessage(swapData: SolanaSwapData, nonce: number, prefix: string, timeout: string, feeRate?: string): Promise<Transaction> {

        const claimerAta = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const tx = new Transaction();

        let result = await this.program.methods
            .offererInitialize(
                swapData.amount,
                swapData.expiry,
                paymentHash,
                new BN(swapData.kind || 0),
                new BN(swapData.confirmations || 0),
                new BN(0),
                new BN(timeout),
                true,
                swapData.txoHash!=null ? Buffer.from(swapData.txoHash, "hex") : Buffer.alloc(32, 0),
                swapData.securityDeposit,
                swapData.claimerBounty
            )
            .accounts({
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                claimerTokenAccount: claimerAta,
                mint: swapData.token,
                userData: this.SwapUserVault(swapData.offerer, swapData.token),
                escrowState: this.SwapEscrowState(paymentHash),
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

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

    async getInitSignature(swapData: SolanaSwapData, nonce: ISwapNonce, authorizationTimeout: number, preFetchedBlockData?: {
        block: ParsedAccountsModeBlockResponse,
        slot: number,
        timestamp: number
    }, feeRate?: string): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");

        if(preFetchedBlockData!=null && Date.now()-preFetchedBlockData.timestamp>PREFETCHED_DATA_VALIDITY) preFetchedBlockData = null;

        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const useNonce = nonce.getNonce(swapData.token.toBase58())+1;

        const txToSign = await this.getInitMessage(swapData, useNonce, authPrefix, authTimeout.toString(10), feeRate);

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.findLatestParsedBlock("finalized");
        txToSign.recentBlockhash = latestBlock.blockhash;
        txToSign.sign(this.signer.signer);

        const sig = txToSign.signatures.find(e => e.publicKey.equals(this.signer.signer.publicKey));

        return {
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: latestSlot+";"+sig.signature.toString("hex")
        };
    }

    async isValidInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, feeRate?: string): Promise<Buffer> {

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

        const [latestSlot, transactionBlock] = await Promise.all([
            this.getCachedSlot("processed"),
            this.getParsedBlock(parseInt(transactionSlot))
        ]);

        const lastValidTransactionSlot = parseInt(transactionSlot)+TX_SLOT_VALIDITY;
        // const latestSlot = await this.getCachedSlot("processed");
        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;
        if(slotsLeft<0) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        // const latestBlock = await this.getParsedBlock(parseInt(transactionSlot));

        const txToSign = await this.getInitMessage(data, nonce, prefix, timeout, feeRate);

        //Check validity of recentBlockhash

        txToSign.recentBlockhash = transactionBlock.blockhash;
        txToSign.addSignature(data.offerer, Buffer.from(signatureString, "hex"));

        const valid = txToSign.verifySignatures(false);

        if(!valid) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Buffer.from(transactionBlock.blockhash);

    }

    async getInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<number> {
        const [transactionSlotStr, signatureString] = signature.split(";");

        const lastValidTransactionSlot = parseInt(transactionSlotStr)+TX_SLOT_VALIDITY;

        const latestSlot = await this.getCachedSlot("processed");

        const slotsLeft = lastValidTransactionSlot-latestSlot-SLOT_BUFFER;

        const now = Date.now();

        const expiry = Math.min(now + (slotsLeft*SLOT_TIME), (parseInt(timeout)-this.authGracePeriod)*1000);

        if(expiry<now) {
            return 0;
        }

        return expiry;
    }

    async isInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<boolean> {
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
            null,
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(prefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[2].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[3] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[4].writeBigUInt64LE(BigInt(timeout));

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

        const account: any = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
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

        const account: any = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account!=null) {
            return new SolanaSwapData(
                account.offerer,
                account.claimer,
                account.mint,
                account.initializerAmount,
                Buffer.from(account.hash).toString("hex"),
                account.expiry,
                account.nonce,
                account.confirmations,
                account.payOut,
                account.kind,
                account.payIn,
                account.claimerTokenAccount,
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
        expiry: BN,
        escrowNonce: BN,
        confirmations: number,
        payIn: boolean,
        payOut: boolean,
        securityDeposit: BN,
        claimerBounty: BN
    ): Promise<SolanaSwapData> {
        return Promise.resolve(new SolanaSwapData(
            offerer==null ? null : new PublicKey(offerer),
            claimer==null ? null : new PublicKey(claimer),
            token,
            amount,
            paymentHash,
            expiry,
            escrowNonce,
            confirmations,
            payOut,
            type==null ? null : SolanaSwapProgram.typeToKind(type),
            payIn,
            null,
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

    async txsClaimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: string): Promise<SolTx[]> {

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

        if(swapData.isPayOut()) {
            const account = await tryWithRetries<SplToken.Account>(async () => {
                try {
                    return await SplToken.getAccount(this.signer.connection, swapData.claimerTokenAccount);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

            if(account==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                const generatedAtaAddress = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
                if(!generatedAtaAddress.equals(swapData.claimerTokenAccount)) {
                    throw new SwapDataVerificationError("Invalid claimer token account address");
                }
                tx.add(
                    SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimer, swapData.token)
                );
            }
        }

        let accounts: {[key: string]: PublicKey};

        if(swapData.isPayOut()) {
            accounts = {
                signer: this.signer.publicKey,
                initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                claimerReceiveTokenAccount: swapData.claimerTokenAccount,
                vault: this.SwapVault(swapData.token),
                vaultAuthority: this.SwapVaultAuthority,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,

                userData: null,

                data: null
            };
        } else {
            accounts = {
                signer: this.signer.publicKey,
                initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                claimerReceiveTokenAccount: null,
                vault: null,
                vaultAuthority: null,
                tokenProgram: null,

                userData: this.SwapUserVault(swapData.claimer, swapData.token),

                data: null
            };
        }

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 50000,
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getClaimFeeRate(swapData)))
        }));
        tx.add(await this.program.methods
            .claimerClaim(Buffer.from(secret, "hex"))
            .accounts(accounts)
            .instruction());

        if(swapData.isPayOut()) {
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    SplToken.createCloseAccountInstruction(swapData.claimerTokenAccount, this.signer.publicKey, this.signer.publicKey)
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

            const account = await tryWithRetries<SplToken.Account>(async () => {
                try {
                    return await SplToken.getAccount(this.signer.connection, swapData.claimerTokenAccount);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

            if(account==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                const generatedAtaAddress = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
                if(!generatedAtaAddress.equals(swapData.claimerTokenAccount)) {
                    throw new SwapDataVerificationError("Invalid claimer token account address");
                }
                ataInitIx = SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimer, swapData.token);
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
                    resp.txs.forEach(tx => {
                        tx.tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: computedFeeRate
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

        const fetchedDataAccount: any = await tryWithRetries(() => this.signer.connection.getAccountInfo(txDataKey.publicKey), this.retryPolicy);

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
                .writeData(pointer, writeData.slice(pointer, writeLen))
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
                .writeData(pointer, writeData.slice(pointer, writeLen))
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
                .claimerClaim(Buffer.alloc(0))
                .accounts({
                    signer: this.signer.publicKey,
                    initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                    claimerReceiveTokenAccount: swapData.claimerTokenAccount,
                    vault: this.SwapVault(swapData.token),
                    vaultAuthority: this.SwapVaultAuthority,
                    tokenProgram: SplToken.TOKEN_PROGRAM_ID,

                    userData: null,

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

                    claimerReceiveTokenAccount: null,
                    vault: null,
                    vaultAuthority: null,
                    tokenProgram: null,

                    userData: this.SwapUserVault(swapData.claimer, swapData.token),

                    data: txDataKey.publicKey
                })
                .instruction();
        }

        const solanaTx = new Transaction();
        solanaTx.add(verifyIx);
        if(ataInitIx!=null) solanaTx.add(ataInitIx);
        solanaTx.add(claimIx);

        if(this.signer.signer==null) {
            //Add compute budget
            solanaTx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: computedFeeRate
            }));
            solanaTx.add(ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000,
            }));

            if(Utils.getTxSize(solanaTx, this.signer.publicKey)>1232) {
                //TX too large
                solanaTx.instructions.pop();
                if(Utils.getTxSize(solanaTx, this.signer.publicKey)>1232) {
                    solanaTx.instructions.pop();
                }
            }
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
                    SplToken.createCloseAccountInstruction(swapData.claimerTokenAccount, this.signer.publicKey, this.signer.publicKey)
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

        let accounts: {[key: string]: PublicKey};

        const tx = new Transaction();

        let ata: PublicKey = null;

        if(swapData.isPayIn()) {

            ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<SplToken.Account>(async () => {
                try {
                    return await SplToken.getAccount(this.signer.connection, ata);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
            }

            accounts = {
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),

                vault: this.SwapVault(swapData.token),
                vaultAuthority: this.SwapVaultAuthority,
                initializerDepositTokenAccount: ata,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,

                userData: null,

                ixSysvar: null
            };
        } else {
            accounts = {
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),

                vault: null,
                vaultAuthority: null,
                initializerDepositTokenAccount: null,
                tokenProgram: null,

                userData: this.SwapUserVault(swapData.offerer, swapData.token),

                ixSysvar: null
            };
        }

        let builder = this.program.methods
            .offererRefund(new BN(0))
            .accounts(accounts);

        if(!swapData.payOut) {
            builder = builder.remainingAccounts([
                {
                    isSigner: false,
                    isWritable: true,
                    pubkey: this.SwapUserVault(swapData.claimer, swapData.token)
                }
            ]);
        }

        let result = await builder.instruction();

        tx.add(result);

        if(swapData.isPayIn()) {
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    SplToken.createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
                );
            }
        }

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000,
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getRefundFeeRate(swapData)))
        }));

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

        let accounts: {[key: string]: PublicKey};

        let ata: PublicKey = null;

        if(swapData.isPayIn()) {

            ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await tryWithRetries<SplToken.Account>(async () => {
                try {
                    return await SplToken.getAccount(this.signer.connection, ata);
                } catch (e) {
                    if(e instanceof TokenAccountNotFoundError) {
                        return null;
                    }
                    throw e;
                }
            }, this.retryPolicy);

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
            }

            accounts = {
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),

                vault: this.SwapVault(swapData.token),
                vaultAuthority: this.SwapVaultAuthority,
                initializerDepositTokenAccount: ata,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,

                userData: null,

                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            };
        } else {
            accounts = {
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),

                vault: null,
                vaultAuthority: null,
                initializerDepositTokenAccount: null,
                tokenProgram: null,

                userData: this.SwapUserVault(swapData.offerer, swapData.token),

                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            };
        }

        let builder = this.program.methods
            .offererRefund(new BN(timeout))
            .accounts(accounts);

        if(!swapData.payOut) {
            builder = builder.remainingAccounts([
                {
                    isSigner: false,
                    isWritable: true,
                    pubkey: this.SwapUserVault(swapData.claimer, swapData.token)
                }
            ]);
        }

        let result = await builder.instruction();

        tx.add(result);

        if(swapData.isPayIn()) {
            if (swapData.token.equals(WSOL_ADDRESS)) {
                //Move to normal SOL
                tx.add(
                    SplToken.createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
                );
            }
        }

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000,
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getRefundFeeRate(swapData)))
        }));

        return [{
            tx,
            signers: []
        }];

    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInitPayIn(swapData,timeout,prefix,signature,nonce,skipChecks,feeRate);

        const signatures = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signatures[signatures.length-1];
    }

    async txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, skipChecks?: boolean, feeRate?: string): Promise<SolTx[]> {

        if(!skipChecks) {
            const [_, payStatus] = await Promise.all([
                tryWithRetries(
                    () => this.isValidClaimInitAuthorization(swapData, timeout, prefix, signature, nonce, feeRate),
                    this.retryPolicy,
                    (e) => e instanceof SignatureVerificationError
                ),
                tryWithRetries(() => this.getPaymentHashStatus(swapData.paymentHash), this.retryPolicy)
            ]);

            if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
                throw new SwapDataVerificationError("Invoice already being paid for or paid");
            }
        }

        const computedFeeRate = parseInt(feeRate || (await this.getInitPayInFeeRate(swapData.offerer.toBase58(), swapData.claimer.toBase58(), swapData.token, swapData.paymentHash)));

        const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);
        const ataIntermediary = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        const txs: SolTx[] = [];

        if(swapData.token.equals(WSOL_ADDRESS)) {
            let balance = new BN(0);
            let accountExists = false;
            try {
                const ataAcc = await tryWithRetries<SplToken.Account>(async () => {
                    try {
                        return await SplToken.getAccount(this.signer.connection, ata);
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

                tx.add(ComputeBudgetProgram.setComputeUnitLimit({
                    units: 100000,
                }));
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: computedFeeRate
                }));

                //Need to wrap some more
                const remainder = swapData.amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, swapData.token));
                }
                tx.add(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                tx.add(SplToken.createSyncNativeInstruction(ata));

                txs.push({
                    tx,
                    signers: []
                });
            }

        }

        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        const tx = new Transaction();

        const ix = await this.program.methods
            .offererInitializePayIn(
                swapData.amount,
                swapData.expiry,
                paymentHash,
                new BN(swapData.kind),
                new BN(swapData.confirmations),
                new BN(timeout),
                swapData.nonce,
                swapData.payOut,
                Buffer.alloc(32, 0)
            )
            .accounts({
                offerer: swapData.offerer,
                initializerDepositTokenAccount: ata,
                claimer: swapData.claimer,
                claimerTokenAccount: ataIntermediary,
                userData: this.SwapUserVault(swapData.claimer, swapData.token),
                escrowState: this.SwapEscrowState(paymentHash),
                vault: this.SwapVault(swapData.token),
                vaultAuthority: this.SwapVaultAuthority,
                mint: swapData.token,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID
            })
            .instruction();

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000,
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: computedFeeRate
        }));
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

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInit(swapData,timeout,prefix,signature,nonce,txoHash,skipChecks,feeRate);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolTx[]> {

        if(!skipChecks) {
            await tryWithRetries(
                () => this.isValidInitAuthorization(swapData, timeout, prefix, signature, nonce, feeRate),
                this.retryPolicy,
                (e) => e instanceof SignatureVerificationError
            );
        }

        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const [slotNumber, signatureStr] = signature.split(";");

        const block = await tryWithRetries(() => this.getParsedBlock(parseInt(slotNumber)), this.retryPolicy);

        const claimerAta = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.claimer);

        const tx = new Transaction();

        let result = await this.program.methods
            .offererInitialize(
                swapData.amount,
                swapData.expiry,
                paymentHash,
                new BN(swapData.kind || 0),
                new BN(swapData.confirmations || 0),
                new BN(0),
                new BN(timeout),
                true,
                txoHash || Buffer.alloc(32, 0),
                swapData.securityDeposit,
                swapData.claimerBounty
            )
            .accounts({
                offerer: swapData.offerer,
                claimer: swapData.claimer,
                claimerTokenAccount: claimerAta,
                mint: swapData.token,
                userData: this.SwapUserVault(swapData.offerer, swapData.token),
                escrowState: this.SwapEscrowState(paymentHash),
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000,
        }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: parseInt(feeRate || (await this.getInitFeeRate(swapData.offerer.toBase58(), swapData.claimer.toBase58(), swapData.token, swapData.paymentHash)))
        }));
        tx.add(result);

        tx.feePayer = swapData.claimer;
        tx.recentBlockhash = block.blockhash;
        tx.lastValidBlockHeight = block.blockHeight + TX_SLOT_VALIDITY;
        tx.addSignature(swapData.offerer, Buffer.from(signatureStr, "hex"));

        return [{
            tx,
            signers: []
        }]

    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string[]> {

        const [txCommit] = await this.txsInit(swapData, timeout, prefix, signature, nonce, null, skipChecks, feeRate);
        const [txClaim] = await this.txsClaimWithSecret(swapData, secret, true, true, feeRate);

        return await this.sendAndConfirm([txCommit, txClaim], waitForConfirmation, abortSignal);

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

        const data: any = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(new PublicKey(address), token));

        if(data==null) return null;

        const response: any = {};

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
        const data: any = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(new PublicKey(address), token));

        if(data==null) return null;

        return data.amount;
    }

    toTokenAddress(address: string): TokenAddress {
        return new PublicKey(address);
    }

    async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        const resp = await this.signer.connection.getRecentPrioritizationFees({
            lockedWritableAccounts: mutableAccounts
        });

        let lamports = resp[0].prioritizationFee;
        if(lamports==null || lamports<0.004000) lamports = 0.004000;

        const microLamports = new BN(lamports * 1000000 * 2);

        return microLamports.toString(10);
    }

    async getInitPayInFeeRate(offerer: string, claimer: string, token: PublicKey, paymentHash?: string): Promise<string> {

        const offererATA = await SplToken.getAssociatedTokenAddress(token, new PublicKey(offerer));
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

        const escrowState = this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex"));

        if(swapData.payIn) {
            const vault = this.SwapVault(swapData.token);

            return await this.getFeeRate([
                swapData.offerer,
                swapData.claimer,
                escrowState,
                vault,
                swapData.claimerTokenAccount
            ]);
        } else {
            const userData = this.SwapUserVault(swapData.offerer, swapData.token);

            return await this.getFeeRate([
                swapData.offerer,
                swapData.claimer,
                escrowState,
                userData
            ]);
        }

    }

    async getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {

        const escrowState = this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex"));

        if(swapData.payIn) {
            const vault = this.SwapVault(swapData.token);

            return await this.getFeeRate([
                this.signer.publicKey,
                swapData.payIn ? swapData.offerer : swapData.claimer,
                escrowState,
                vault,
                swapData.claimerTokenAccount
            ]);
        } else {
            const userData = this.SwapUserVault(swapData.claimer, swapData.token);

            return await this.getFeeRate([
                this.signer.publicKey,
                swapData.payIn ? swapData.offerer : swapData.claimer,
                escrowState,
                userData
            ]);
        }

    }

    private getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(2039280));
    }

    getClaimFee(): Promise<BN> {
        return Promise.resolve(new BN(-2707440+5000));
    }

    getRawClaimFee(): Promise<BN> {
        return Promise.resolve(new BN(5000));
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): Promise<BN> {
        return Promise.resolve(new BN(2707440+10000));
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(): Promise<BN> {
        return Promise.resolve(new BN(-2707440+10000));
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRawRefundFee(): Promise<BN> {
        return Promise.resolve(new BN(10000));
    }

    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.claimer = this.signer.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerTokenAccount = SplToken.getAssociatedTokenAddressSync(swapData.token, this.signer.publicKey);
    }

    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.signer.publicKey;
        swapData.payIn = true;
    }

    getNativeCurrencyAddress(): TokenAddress {
        return WSOL_ADDRESS;
    }

    async withdraw(token: any, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const txs = await this.txsWithdraw(token, amount);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsWithdraw(token: any, amount: BN): Promise<SolTx[]> {
        const ata = await SplToken.getAssociatedTokenAddress(token, this.signer.publicKey);

        const tx = new Transaction();

        const account = await tryWithRetries<SplToken.Account>(async () => {
            try {
                return await SplToken.getAccount(this.signer.connection, ata);
            } catch (e) {
                if(e instanceof TokenAccountNotFoundError) {
                    return null;
                }
                throw e;
            }
        }, this.retryPolicy);
        if(account==null) {
            tx.add(
                SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token)
            );
        }

        let ix = await this.program.methods
            .withdraw(new BN(amount))
            .accounts({
                initializer: this.signer.publicKey,
                userData: this.SwapUserVault(this.signer.publicKey, token),
                mint: token,
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                initializerDepositTokenAccount: ata,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,
            })
            .instruction();

        tx.add(ix);

        if (WSOL_ADDRESS.equals(token)) {
            //Move to normal SOL
            tx.add(
                SplToken.createCloseAccountInstruction(ata, this.signer.publicKey, this.signer.publicKey)
            );
        }

        return [{
            tx,
            signers: []
        }];
    }
    async deposit(token: any, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const txs = await this.txsDeposit(token, amount);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsDeposit(token: any, amount: BN): Promise<SolTx[]> {
        const ata = await SplToken.getAssociatedTokenAddress(token, this.signer.publicKey);

        const tx = new Transaction();

        if(WSOL_ADDRESS.equals(token)) {
            let accountExists: boolean = false;
            let balance: BN = new BN(0);

            const ataAcc = await tryWithRetries<SplToken.Account>(async () => {
                try {
                    return await SplToken.getAccount(this.signer.connection, ata);
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
                    tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, this.signer.publicKey, token));
                }
                tx.add(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                tx.add(SplToken.createSyncNativeInstruction(ata));
            }
        }

        let depositIx = await this.program.methods
            .deposit(new BN(amount))
            .accounts({
                initializer: this.signer.publicKey,
                userData: this.SwapUserVault(this.signer.publicKey, token),
                mint: token,
                vault: this.SwapVault(token),
                vaultAuthority: this.SwapVaultAuthority,
                initializerDepositTokenAccount: ata,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: SplToken.TOKEN_PROGRAM_ID,
            })
            .instruction();

        tx.add(depositIx);

        return [{
            tx,
            signers: []
        }]
    }
    async transfer(token: any, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress);
        const [txId] = await this.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }
    async txsTransfer(token: any, amount: BN, dstAddress: string): Promise<SolTx[]> {
        if(WSOL_ADDRESS.equals(token)) {
            return [{
                tx: new Transaction().add(SystemProgram.transfer({
                    fromPubkey: this.signer.publicKey,
                    toPubkey: new PublicKey(dstAddress),
                    lamports: BigInt(amount.toString(10))
                })),
                signers: []
            }];
        }

        const ata = await SplToken.getAssociatedTokenAddress(token, this.signer.publicKey);

        if(!PublicKey.isOnCurve(new PublicKey(dstAddress))) {
            throw new Error("Recipient must be a valid public key");
        }

        const dstAta = SplToken.getAssociatedTokenAddressSync(token, new PublicKey(dstAddress), false);

        const tx = new Transaction();

        const account = await tryWithRetries<SplToken.Account>(async () => {
            try {
                return await SplToken.getAccount(this.signer.connection, dstAta);
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
                SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, dstAta, new PublicKey(dstAddress), token)
            );
        }

        const ix = SplToken.createTransferInstruction(ata, dstAta, this.signer.publicKey, BigInt(amount.toString(10)));
        tx.add(ix);

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
