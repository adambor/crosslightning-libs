import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, BorshCoder, EventParser, Program} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    Ed25519Program,
    Keypair,
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

export class SolanaSwapProgram implements SwapContract<SolanaSwapData, SolTx> {

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

    constructor(signer: AnchorProvider & {signer?: Signer}, btcRelay: SolanaBtcRelay<any>, storage: IStorageManager<StoredDataAccount>) {
        this.signer = signer;
        this.program = new Program(programIdl as any, programIdl.metadata.address, signer);
        this.coder = new BorshCoder(programIdl as any);
        this.eventParser = new EventParser(this.program.programId, this.coder);

        this.btcRelay = btcRelay;

        this.storage = storage;

        this.SwapVaultAuthority = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
    }

    saveDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.saveData(publicKey.toBase58(), new StoredDataAccount(publicKey));
    }

    removeDataAccount(publicKey: PublicKey): Promise<void> {
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
            const ourAta = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);

            if(!swapData.claimerTokenAccount.equals(ourAta)) {
                //Invalid ATA specified as our ATA
                return false;
            }
        }
        return swapData.intermediary.equals(this.signer.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.signer.publicKey);
    }

    async getBalance(token: TokenAddress, inContract: boolean): Promise<BN> {
        if(inContract) {
            const tokenAccount: any = await this.program.account.userAccount.fetch(this.SwapUserVault(this.signer.publicKey, token));
            return new BN(tokenAccount.amount.toString(10));
        } else {
            const ata: PublicKey = SplToken.getAssociatedTokenAddressSync(token, this.signer.publicKey);
            let ataExists: boolean = false;
            let sum: BN = new BN(0);
            try {
                const account = await SplToken.getAccount(this.signer.connection, ata);
                if(account!=null) {
                    ataExists = true;
                    sum = sum.add(new BN(account.amount.toString()));
                }
            } catch (e) {}

            if(token!=null && token.equals(WSOL_ADDRESS)) {
                let balanceLamports: BN = new BN(await this.signer.connection.getBalance(this.signer.publicKey));
                if(!ataExists) balanceLamports = balanceLamports.sub(await this.getATARentExemptLamports());
                balanceLamports = balanceLamports.sub(this.getCommitFee()); //Discount commit fee
                balanceLamports = balanceLamports.sub(new BN(5000)); //Discount refund fee
                if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
            }

            return sum;
        }
    }

    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {

        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(escrowState==null) throw new Error();

            if(
                !escrowState.offerer.equals(data.offerer) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
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
        } catch (e) {
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
        try {
            const escrowState = await this.program.account.escrowState.fetch(escrowStateKey);
            if(escrowState!=null) {
                return SwapCommitStatus.COMMITED;
            }
        } catch (e) {
            console.log(e);
        }

        //Check if paid or what
        const signatures = await this.signer.connection.getSignaturesForAddress(escrowStateKey, {
            limit: 500
        });

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

    getClaimInitMessage(swapData: SolanaSwapData, nonce: number, prefix: string, timeout: string): Buffer {

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(prefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(nonce));
        messageBuffers[2] = swapData.token.toBuffer();
        messageBuffers[3].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[4].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[5] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[6].writeUint8(swapData.kind || 0);
        messageBuffers[7].writeUint16LE(swapData.confirmations || 0);
        messageBuffers[8].writeBigUInt64LE(BigInt(timeout));

        if(swapData.payOut===true) {
            const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);
            messageBuffers.push(Buffer.alloc(1, 1));
            messageBuffers.push(ata.toBuffer());
        } else {
            messageBuffers.push(Buffer.alloc(1, 0));
        }

        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        return messageBuffer;

    }

    getClaimInitSignature(swapData: SolanaSwapData, nonce: ISwapNonce, authorizationTimeout: number): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");
        const authPrefix = "claim_initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const useNonce = nonce.getClaimNonce(swapData.token.toBase58())+1;

        const messageBuffer = this.getClaimInitMessage(swapData, useNonce, authPrefix, authTimeout.toString());
        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    async isValidClaimInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer> {

        if(prefix!=="claim_initialize") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.authGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        //Check correctness of nonce
        const userAccount: any = await this.program.account.userAccount.fetch(this.SwapUserVault(data.intermediary, data.token));

        if(nonce<=userAccount.claimNonce.toNumber()) {
            throw new SignatureVerificationError("Invalid nonce!");
        }

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = this.getClaimInitMessage(data, nonce, prefix, timeout);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.intermediary.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return messageBuffer;

    }

    getInitMessage(swapData: SolanaSwapData, nonce: number, prefix: string, timeout: string): Buffer {

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(prefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(nonce));
        messageBuffers[2] = swapData.token.toBuffer();
        messageBuffers[3] = swapData.intermediary.toBuffer();
        messageBuffers[4].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[5].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[6] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[7].writeUint8(swapData.kind || 0);
        messageBuffers[8].writeUint16LE(swapData.confirmations || 0);
        messageBuffers[9].writeBigUInt64LE(BigInt(timeout));

        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        return messageBuffer;

    }

    getInitSignature(swapData: SolanaSwapData, nonce: ISwapNonce, authorizationTimeout: number): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        if(this.signer.signer==null) throw new Error("Unsupported");
        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;
        const useNonce = nonce.getNonce(swapData.token.toBase58())+1;

        const messageBuffer = this.getInitMessage(swapData, useNonce, authPrefix, authTimeout.toString(10));
        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    async isValidInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer> {

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

        //Check correctness of nonce
        const userAccount: any = await this.program.account.userAccount.fetch(this.SwapUserVault(data.offerer, data.token));

        if(nonce<=userAccount.nonce.toNumber()) {
            throw new SignatureVerificationError("Invalid nonce!");
        }

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = this.getInitMessage(data, nonce, prefix, timeout);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.offerer.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return messageBuffer;

    }

    getRefundMessage(swapData: SolanaSwapData, prefix: string, timeout: string): Buffer {

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

        if(!sign.detached.verify(messageBuffer, signatureBuffer, swapData.intermediary.toBuffer())) {
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

        try {
            const account: any = await this.program.account.escrowState.fetch(this.SwapEscrowState(paymentHash));
            if(account!=null) {
                if(
                    account.kind===swapData.kind &&
                    account.confirmations===swapData.confirmations &&
                    swapData.nonce.eq(account.nonce) &&
                    Buffer.from(account.hash).equals(paymentHash) &&
                    account.payIn===swapData.payIn &&
                    account.payOut===swapData.payOut &&
                    account.offerer.equals(swapData.offerer) &&
                    account.claimer.equals(swapData.intermediary) &&
                    new BN(account.expiry.toString(10)).eq(swapData.expiry) &&
                    new BN(account.initializerAmount.toString(10)).eq(swapData.amount) &&
                    account.mint.equals(swapData.token)
                ) {
                    return true;
                }
            }
        } catch (e) {
            console.error(e);
        }
        return false;
    }

    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(0);
        if(this.areWeOfferer(data)) {
            currentTimestamp = new BN(Math.floor(Date.now()/1000)-this.refundGracePeriod);
        }
        if(this.areWeClaimer(data)) {
            const currentTimestamp = new BN(Math.floor(Date.now()/1000)+this.claimGracePeriod);
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

        try {
            const account: any = await this.program.account.escrowState.fetch(this.SwapEscrowState(paymentHash));
            if(account!=null) {
                return new SolanaSwapData(
                    account.initializerKey,
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
                    null
                );
            }
        } catch (e) {
            console.error(e);
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

    createSwapData(type: ChainSwapType, offerer: string, claimer: string, token: TokenAddress, amount: BN, paymentHash: string, expiry: BN, escrowNonce: BN, confirmations: number, payOut: boolean): SolanaSwapData {
        return new SolanaSwapData(
            null,
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
            null,
            null,
            null
        );
    }

    async sendAndConfirm(txs: SolTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean): Promise<string[]> {
        const {blockhash, lastValidBlockHeight} = await this.signer.connection.getLatestBlockhash();

        for(let tx of txs) {
            tx.tx.recentBlockhash = blockhash;
            tx.tx.feePayer = this.signer.publicKey;
            if(tx.signers!=null && tx.signers.length>0) for(let signer of tx.signers) tx.tx.sign(signer);
        }

        const signedTxs = await this.signer.wallet.signAllTransactions(txs.map(e => e.tx));

        const options = {
            //skipPreflight: true
        };

        const signatures: string[] = [];
        if(parallel) {
            const promises = [];
            for(let tx of signedTxs) {
                const txResult = await this.signer.connection.sendRawTransaction(tx.serialize(), options);
                console.log("Send signed TX: ", txResult);
                if(waitForConfirmation) {
                    promises.push(this.signer.connection.confirmTransaction({
                        signature: txResult,
                        blockhash: blockhash,
                        lastValidBlockHeight: lastValidBlockHeight,
                        abortSignal
                    }, "confirmed"));
                }
                signatures.push(txResult);
            }
            if(promises.length>0) {
                await Promise.all(promises);
            }
        } else {
            let lastTx;
            if(!waitForConfirmation) {
                lastTx = signedTxs.pop();
            }
            for(let tx of signedTxs) {
                const txResult = await this.signer.connection.sendRawTransaction(tx.serialize(), options);
                console.log("Send signed TX: ", txResult);
                await this.signer.connection.confirmTransaction({
                    signature: txResult,
                    blockhash: blockhash,
                    lastValidBlockHeight: lastValidBlockHeight,
                    abortSignal
                }, "confirmed");
                signatures.push(txResult);
            }
            if(lastTx!=null) {
                const txResult = await this.signer.connection.sendRawTransaction(lastTx.serialize(), options);
                console.log("Send signed TX: ", txResult);
                signatures.push(txResult);
            }
        }

        return signatures;
    }


    async claimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, waitForConfirmation?, abortSignal?: AbortSignal): Promise<string> {

        const result = await this.txsClaimWithSecret(swapData, secret);

        const [signature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return signature;

    }

    async txsClaimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean): Promise<SolTx[]> {

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
            const account = await SplToken.getAccount(this.signer.connection, swapData.claimerTokenAccount).catch(e => console.error(e));
            if(account==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                const generatedAtaAddress = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);
                if(!generatedAtaAddress.equals(swapData.claimerTokenAccount)) {
                    throw new SwapDataVerificationError("Invalid claimer token account address");
                }
                tx.add(
                    SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimerTokenAccount, swapData.token)
                );
            }
        }

        let accounts: {[key: string]: PublicKey};

        if(swapData.isPayOut()) {
            accounts = {
                signer: this.signer.publicKey,
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
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                claimerReceiveTokenAccount: null,
                vault: null,
                vaultAuthority: null,
                tokenProgram: null,

                userData: this.SwapUserVault(swapData.intermediary, swapData.token),

                data: null
            };
        }

        tx.add(await this.program.methods
            .claimerClaim(Buffer.from(secret, "hex"))
            .accounts(accounts)
            .instruction());

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
        abortSignal?: AbortSignal
    ): Promise<string> {

        const data: {storageAcc: PublicKey} = {
            storageAcc: null
        };

        const txs = await this.txsClaimWithTxData(swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, data);

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
        storageAccHolder?: {storageAcc: PublicKey}
    ): Promise<SolTx[] | null> {

        let ataInitIx: TransactionInstruction;
        if(swapData.isPayOut()) {
            const account = await SplToken.getAccount(this.signer.connection, swapData.claimerTokenAccount).catch(e => console.error(e));
            if(account==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

                const generatedAtaAddress = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);
                if(!generatedAtaAddress.equals(swapData.claimerTokenAccount)) {
                    throw new SwapDataVerificationError("Invalid claimer token account address");
                }
                ataInitIx = SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, generatedAtaAddress, swapData.claimerTokenAccount, swapData.token);
            }
        }

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);

        const txs: SolTx[] = [];

        if(synchronizer==null) {
            if(commitedHeader==null) try {
                const result = await this.btcRelay.retrieveLogAndBlockheight(tx.blockhash, blockheight+swapData.getConfirmations()-1);
                commitedHeader = result.header;
            } catch (e) {
                console.error(e);
            }

            console.log("[Solana.Claim] Commited header retrieved: ", commitedHeader);

            if(commitedHeader==null) return null;
        } else {
            if(commitedHeader==null) {
                const requiredBlockheight = merkleProof.blockheight+swapData.getConfirmations()-1;

                const result = await this.btcRelay.retrieveLogAndBlockheight(tx.blockhash);

                commitedHeader = result.header;
                if(result.height<requiredBlockheight) {
                    //Need to synchronize
                    //TODO: We don't have to synchronize to tip, only to our required blockheight
                    const resp = await synchronizer.syncToLatestTxs();
                    console.log("BTC Relay not synchronized to required blockheight, synchronizing ourselves in "+resp.txs.length+" txs");
                    console.log("BTC Relay computed header map: ",resp.computedHeaderMap);
                    if(commitedHeader==null) {
                        //Retrieve computed header
                        commitedHeader = resp.computedHeaderMap[merkleProof.blockheight];
                    }
                    resp.txs.forEach(tx => txs.push(tx));
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

        const fetchedDataAccount: any = await this.signer.connection.getAccountInfo(txDataKey.publicKey);

        let pointer = 0;
        if(fetchedDataAccount==null) {
            const dataSize = writeData.length;
            const accountSize = 32+dataSize;
            const lamports = await this.signer.connection.getMinimumBalanceForRentExemption(accountSize);

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

            const writeLen = Math.min(writeData.length-pointer, 500);

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
                    escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                    claimerReceiveTokenAccount: null,
                    vault: null,
                    vaultAuthority: null,
                    tokenProgram: null,

                    userData: this.SwapUserVault(swapData.intermediary, swapData.token),

                    data: txDataKey.publicKey
                })
                .instruction();
        }

        const solanaTx = new Transaction();
        solanaTx.add(verifyIx);
        if(ataInitIx!=null) solanaTx.add(ataInitIx);
        solanaTx.add(claimIx);

        txs.push({
            tx: solanaTx,
            signers: []
        });

        return txs;

    }

    async refund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        let result = await this.txsRefund(swapData);

        const [signature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signature;
    }

    async txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean): Promise<SolTx[]> {

        if(check) {
            if(!(await this.isRequestRefundable(swapData))) {
                throw new SwapDataVerificationError("Not refundable yet!");
            }
        }

        let accounts: {[key: string]: PublicKey};

        const tx = new Transaction();

        if(swapData.isPayIn()) {

            const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await SplToken.getAccount(this.signer.connection, ata).catch(e => console.error(e));

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
            }

            accounts = {
                offerer: swapData.offerer,
                initializer: swapData.initializer,
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
                initializer: swapData.initializer,
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
                    pubkey: this.SwapUserVault(swapData.intermediary, swapData.token)
                }
            ]);
        }

        let result = await builder.instruction();

        tx.add(result);

        return [{
            tx,
            signers: []
        }];
    }

    async refundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        let result = await this.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsRefundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean): Promise<SolTx[]> {
        if(check) {
            if(!(await this.isCommited(swapData))) {
                throw new SwapDataVerificationError("Not correctly committed");
            }
        }

        const messageBuffer = await this.isValidRefundAuthorization(swapData, timeout, prefix, signature);
        const signatureBuffer = Buffer.from(signature, "hex");

        const tx = new Transaction();

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.intermediary.toBuffer(),
            signature: signatureBuffer
        }));

        let accounts: {[key: string]: PublicKey};

        if(swapData.isPayIn()) {

            const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            const ataAccount = await SplToken.getAccount(this.signer.connection, ata).catch(e => console.error(e));

            if(ataAccount==null) {
                if(!initAta) throw new SwapDataVerificationError("ATA is not initialized!");
                tx.add(SplToken.createAssociatedTokenAccountInstruction(this.signer.publicKey, ata, swapData.offerer, swapData.token));
            }

            accounts = {
                offerer: swapData.offerer,
                initializer: swapData.initializer,
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
                initializer: swapData.initializer,
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
                    pubkey: this.SwapUserVault(swapData.intermediary, swapData.token)
                }
            ]);
        }

        let result = await builder.instruction();

        tx.add(result);

        return [{
            tx,
            signers: []
        }];

    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        let result = await this.txsInitPayIn(swapData,timeout,prefix,signature,nonce);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<SolTx[]> {

        const messageBuffer = await this.isValidClaimInitAuthorization(swapData, timeout, prefix, signature, nonce);

        const payStatus = await this.getPaymentHashStatus(swapData.paymentHash);

        if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
            throw new SwapDataVerificationError("Invoice already being paid for or paid");
        }

        const ata = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.offerer);
        const ataIntermediary = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);

        const tx = new Transaction();

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.intermediary.toBuffer(),
            signature: Buffer.from(signature, "hex")
        }));

        if(swapData.token.equals(WSOL_ADDRESS)) {
            let balance = new BN(0);
            let accountExists = false;
            try {
                const ataAcc = await SplToken.getAccount(this.signer.connection, ata);
                if(ataAcc!=null) {
                    accountExists = true;
                    balance = balance.add(new BN(ataAcc.amount.toString()));
                }
            } catch (e) {}
            if(balance.lt(swapData.amount)) {
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
            }
        }

        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const ix = await this.program.methods
            .offererInitializePayIn(
                new BN(nonce),
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
                initializer: swapData.offerer,
                initializerDepositTokenAccount: ata,
                claimer: swapData.intermediary,
                claimerTokenAccount: ataIntermediary,
                userData: this.SwapUserVault(swapData.intermediary, swapData.token),
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

        tx.add(ix);

        return [{
            tx,
            signers: []
        }];

    }

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        let result = await this.txsInit(swapData,timeout,prefix,signature,nonce,txoHash);

        const [txSignature] = await this.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<SolTx[]> {

        const messageBuffer = await this.isValidInitAuthorization(swapData, timeout, prefix, signature, nonce);

        const paymentHash = Buffer.from(swapData.paymentHash, "hex");
        const signatureBuffer = Buffer.from(signature, "hex");

        const claimerAta = SplToken.getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);

        const tx = new Transaction();

        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: swapData.offerer.toBuffer(),
            signature: signatureBuffer
        }));

        let result = await this.program.methods
            .offererInitialize(
                new BN(nonce),
                swapData.amount,
                swapData.expiry,
                paymentHash,
                new BN(swapData.kind || 0),
                new BN(swapData.confirmations || 0),
                new BN(0),
                new BN(timeout),
                true,
                txoHash || Buffer.alloc(32, 0)
            )
            .accounts({
                initializer: swapData.intermediary,
                offerer: swapData.offerer,
                claimer: swapData.intermediary,
                claimerTokenAccount: claimerAta,
                mint: swapData.token,
                userData: this.SwapUserVault(swapData.offerer, swapData.token),
                escrowState: this.SwapEscrowState(paymentHash),
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        tx.add(result);

        return [{
            tx,
            signers: []
        }]

    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string[]> {

        const [txCommit] = await this.txsInit(swapData, timeout, prefix, signature, nonce);
        const [txClaim] = await this.txsClaimWithSecret(swapData, secret, true);

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

        const data: any = await this.program.account.userAccount.fetch(this.SwapUserVault(new PublicKey(address), token));

        const response: any = {};

        for(let i=0;i<3;i++) {
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
        const data: any = await this.program.account.userAccount.fetch(this.SwapUserVault(new PublicKey(address), token));

        return data.amount;
    }

    toTokenAddress(address: string): TokenAddress {
        return new PublicKey(address);
    }


    getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(2039280));
    }

    getClaimFee(): BN {
        return new BN(-2707440+5000);
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): BN {
        return new BN(2707440+10000);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(): BN {
        return new BN(-2707440+10000);
    }

    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.intermediary = this.signer.publicKey;
        swapData.initializer = this.signer.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerTokenAccount = SplToken.getAssociatedTokenAddressSync(swapData.token, this.signer.publicKey);
    }

    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.signer.publicKey;
        swapData.initializer = this.signer.publicKey;
        swapData.payIn = true;
    }

}
