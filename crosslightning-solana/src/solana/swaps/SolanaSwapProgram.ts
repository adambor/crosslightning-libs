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
import {SolanaBase, SolanaRetryPolicy, SolanaTx} from "../base/SolanaBase";
import {getLogger} from "./Utils";
import {SolanaProgramBase} from "../program/SolanaProgramBase";
import {SolanaAction} from "../base/SolanaAction";
import {SolanaTokens} from "../base/modules/SolanaTokens";


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

    readonly SwapVaultAuthority = this.pda("authority");
    readonly SwapVault = this.pda("vault", (tokenAddress: PublicKey) => [tokenAddress.toBuffer()]);
    readonly SwapUserVault = this.pda("uservault",
        (publicKey: PublicKey, tokenAddress: PublicKey) => [publicKey.toBuffer(), tokenAddress.toBuffer()]
    );
    readonly SwapEscrowState = this.pda("state", (hash: Buffer) => [hash]);
    readonly SwapTxDataAlt = this.keypair(
        (reversedTxId: Buffer, signer: Signer) => [Buffer.from(signer.secretKey), reversedTxId]
    );
    readonly SwapTxDataAltBuffer = this.keypair((reversedTxId: Buffer, secret: Buffer) => [secret, reversedTxId]);

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
    }

    async preFetchForInitSignatureVerification(data: SolanaPreFetchData): Promise<SolanaPreFetchVerification> {
        const [latestSlot, txBlock] = await Promise.all([
            this.Slots.getCachedSlotAndTimestamp("processed"),
            this.Blocks.getParsedBlock(data.slot)
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
        const latestParsedBlock = await this.Blocks.findLatestParsedBlock("finalized");
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
    async CloseDataAccount(publicKey: PublicKey): Promise<SolanaAction> {
        return new SolanaAction(
            this,
            await this.program.methods
                .closeData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: publicKey
                })
                .instruction(),
            SolanaSwapProgram.CUCosts.DATA_REMOVE,
            await this.Fees.getFeeRate([this.provider.publicKey, publicKey])
        );
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
            await (await this.CloseDataAccount(publicKey)).addTx(txns);
        }

        const result = await this.Transactions.sendAndConfirm(txns, true, null, true);

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

        let balance = await this.Tokens.getTokenBalance(token);
        if(token.equals(this.Tokens.WSOL_ADDRESS)) {
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
        const status = await this.Events.findInEvents(escrowStateKey, async (event) => {
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
        const eventsPromise = this.Events.findInEvents(escrowStateKey, async (event) => {
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
    private async Init(swapData: SolanaSwapData, timeout: BN): Promise<SolanaAction> {
        const claimerAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");
        const accounts = {
            claimer: swapData.claimer,
            offerer: swapData.offerer,
            escrowState: this.SwapEscrowState(paymentHash),
            mint: swapData.token,
            systemProgram: SystemProgram.programId,
            claimerAta: swapData.payOut ? claimerAta : null,
            claimerUserData: !swapData.payOut ? this.SwapUserVault(swapData.claimer, swapData.token) : null
        };

        if(swapData.payIn) {
            const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            return new SolanaAction(this,
                await this.program.methods
                    .offererInitializePayIn(
                        swapData.toSwapDataStruct(),
                        [...Buffer.alloc(32, 0)],
                        timeout,
                    )
                    .accounts({
                        ...accounts,
                        offererAta: ata,
                        vault: this.SwapVault(swapData.token),
                        vaultAuthority: this.SwapVaultAuthority,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .instruction(),
                SolanaSwapProgram.CUCosts.INIT_PAY_IN
            );
        } else {
            return new SolanaAction(this,
                await this.program.methods
                    .offererInitialize(
                        swapData.toSwapDataStruct(),
                        swapData.securityDeposit,
                        swapData.claimerBounty,
                        [...(swapData.txoHash!=null ? Buffer.from(swapData.txoHash, "hex") : Buffer.alloc(32, 0))],
                        new BN(timeout)
                    )
                    .accounts({
                        ...accounts,
                        offererUserData: this.SwapUserVault(swapData.offerer, swapData.token),
                    })
                    .instruction(),
                SolanaSwapProgram.CUCosts.INIT_PAY_IN
            );
        }
    }

    private extractAtaDataFromFeeRate(feeRate: string): {balance: BN, initAta: boolean} | null {
        const hashArr = feeRate==null ? [] : feeRate.split("#");
        if(hashArr.length<=1) return null;

        const arr = hashArr[1].split(";");
        if(arr.length<=1) return null;

        return {
            balance: new BN(arr[1]),
            initAta: arr[0]==="1"
        }
    }

    /**
     * Checks whether a wrap instruction (SOL -> WSOL) should be a part of the signed init message
     *
     * @param swapData
     * @param feeRate
     * @private
     * @returns {boolean} returns true if wrap instruction should be added
     */
    private shouldWrapOnInit(swapData: SolanaSwapData, feeRate: string): boolean {
        const data = this.extractAtaDataFromFeeRate(feeRate);
        if(data==null) return false;
        return data.balance.lt(swapData.amount);
    }

    private Wrap(
        swapData: SolanaSwapData,
        feeRate?: string
    ): SolanaAction {
        const data = this.extractAtaDataFromFeeRate(feeRate);
        if(data==null) throw new Error("Tried to add wrap instruction, but feeRate malformed: "+feeRate);

        const instructions: TransactionInstruction[] = [];
        let computeBudget = SolanaTokens.CUCosts.WRAP_SOL;
        if(data.initAta) {
            computeBudget += SolanaTokens.CUCosts.ATA_INIT;
            instructions.push(createAssociatedTokenAccountInstruction(swapData.offerer, swapData.offererAta, swapData.offerer, swapData.token));
        }
        instructions.push(SystemProgram.transfer({
            fromPubkey: swapData.offerer,
            toPubkey: swapData.offererAta,
            lamports: BigInt(swapData.amount.sub(data.balance).toString(10))
        }));
        instructions.push(createSyncNativeInstruction(swapData.offererAta));
        return new SolanaAction(this, instructions, computeBudget, feeRate);
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

        let computeBudget = 0;
        let instructions: TransactionInstruction[] = [];

        if(this.shouldWrapOnInit(swapData, feeRate)) computeBudget += this.Wrap(swapData, feeRate).addIxs(instructions);
        computeBudget += (await this.Init(swapData, new BN(timeout))).addIxs(instructions);

        return this.Transactions.createTransaction(instructions, computeBudget, feeRate).tx;
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

        const {block: latestBlock, slot: latestSlot} = preFetchedBlockData || await this.Blocks.findLatestParsedBlock("finalized");

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
            preFetchedData.latestSlot.timestamp>Date.now()-this.Slots.SLOT_CACHE_TIME
        ) {
            return Promise.resolve(preFetchedData.latestSlot.slot+Math.floor((Date.now()-preFetchedData.latestSlot.timestamp)/this.SLOT_TIME));
        }
        return this.Slots.getCachedSlot("processed");
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
        return this.Blocks.getParsedBlock(txSlot).then(val => val.blockhash);
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
        const latestSlot = await this.Slots.getCachedSlot("finalized");
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

        return this.Transactions.createTransaction([
            createAssociatedTokenAccountIdempotentInstruction(swapData.claimer, swapData.claimerAta, swapData.claimer, swapData.token),
            ...(await this.Init(swapData, new BN(timeout))).ixs()
        ], SolanaSwapProgram.CUCosts.INIT, feeRate).tx;
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
        const [signature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);
        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return signature;
    }

    /**
     * Checks if ATA exists, if not, throws an error (if initAta=false)
     *
     * @param swapData
     * @param initAta
     * @private
     * @returns {Promise<boolean>} whether an ATA should be initiated
     */
    private async checkAtaExists(swapData: SolanaSwapData, initAta: boolean): Promise<boolean> {
        if(!swapData.isPayOut()) return false;

        const account = await tryWithRetries<Account>(
            () => this.Tokens.getATAOrNull(swapData.claimerAta),
            this.retryPolicy
        );
        if(account!=null) return false;

        if(!initAta) throw new SwapDataVerificationError("ATA not initialized");

        return true;
    }

    /**
     * Adds instructions for initiating the required claimer ATA to the provided instructions array
     *
     * @param swapData
     * @param instructions
     * @private
     * @returns {Promise<number>} a compute budget required for the added instructions
     */
    private async addIxsInitAta(swapData: SolanaSwapData, instructions: TransactionInstruction[]): Promise<number> {
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

        return SolanaTokens.CUCosts.ATA_INIT;
    }

    private async addTxsInitAta(swapData: SolanaSwapData, feeRate: string, txs: SolanaTx[]): Promise<void> {
        const ataInitInstructions: TransactionInstruction[] = [];
        const ataInitComputeBudget: number = await this.addIxsInitAta(swapData, ataInitInstructions);
        txs.push(this.Transactions.createTransaction(ataInitInstructions, ataInitComputeBudget, feeRate));
    }

    /**
     * Checks if ATA exists, if not, throws an error (if initAta=false) or adds ata init IX to the
     *  IX array (if initAta=true)
     *
     * @param swapData
     * @param initAta
     * @param instructions
     * @private
     * @returns {Promise<number>} a compute budget required for the added instructions
     */
    private async checkAtaAndIxsInitAta(
        swapData: SolanaSwapData,
        initAta: boolean,
        instructions: TransactionInstruction[]
    ): Promise<number> {
        const shouldInitAta = await this.checkAtaExists(swapData, initAta);
        if(!shouldInitAta) return 0;
        return await this.addIxsInitAta(swapData, instructions);
    }

    /**
     * Adds instructions for unwrapping WSOL to SOL to the provided instructions array
     *
     * @param swapData
     * @param instructions
     * @private
     * @returns {number} a compute budget required for the added instructions
     */
    private addIxsUnwrap(swapData: SolanaSwapData, instructions: TransactionInstruction[]): number {
        instructions.push(
            createCloseAccountInstruction(swapData.claimerAta, this.provider.publicKey, this.provider.publicKey)
        );
        return SolanaTokens.CUCosts.ATA_CLOSE;
    }

    /**
     * Adds transactions for unwrapping WSOL to SOL to the provided txs array
     *
     * @param swapData
     * @param feeRate
     * @param txs
     * @private
     */
    private addTxsUnwrap(swapData: SolanaSwapData, feeRate: string, txs: SolanaTx[]): void {
        const instructions: TransactionInstruction[] = [];
        const computeBudget = this.addIxsUnwrap(swapData, instructions);
        txs.push(this.Transactions.createTransaction(instructions, computeBudget, feeRate));
    }

    /**
     * Checks whether we should unwrap the WSOL to SOL when claiming the swap
     *
     * @param swapData
     * @private
     */
    private checkShouldUnwrap(swapData: SolanaSwapData): boolean {
        return swapData.isPayOut() &&
            swapData.token.equals(this.Tokens.WSOL_ADDRESS) &&
            swapData.claimer.equals(this.provider.publicKey);
    }

    /**
     * Checks if the swap output should be unwrapped and if yes adds the unwrap instruction to the IX array
     *
     * @param swapData
     * @param instructions
     * @private
     * @returns {number} compute budget required for the added instructions
     */
    private checkAndAddIxsUnwrap(swapData: SolanaSwapData, instructions: TransactionInstruction[]): number {
        if(!this.checkShouldUnwrap(swapData)) return 0;
        return this.addIxsUnwrap(swapData, instructions);
    }

    private addIxsClaim(swapData: SolanaSwapData, secret: string, instructions: TransactionInstruction[]);
    private addIxsClaim(swapData: SolanaSwapData, dataKey: PublicKey, instructions: TransactionInstruction[]);

    private async addIxsClaim(
        swapData: SolanaSwapData,
        secretOrDataKey: string | PublicKey,
        instructions: TransactionInstruction[]
    ): Promise<number> {
        const isDataKey = typeof(secretOrDataKey)!=="string";

        const accounts = {
            signer: this.provider.publicKey,
            initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
            escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
            ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            data: isDataKey ? secretOrDataKey : null,
        };
        let secretBuffer = isDataKey ?
            Buffer.alloc(0) :
            Buffer.from(secretOrDataKey, "hex");

        if(swapData.isPayOut()) {
            instructions.push(
                await this.program.methods
                    .claimerClaimPayOut(secretBuffer)
                    .accounts({
                        ...accounts,
                        claimerAta: swapData.claimerAta,
                        vault: this.SwapVault(swapData.token),
                        vaultAuthority: this.SwapVaultAuthority,
                        tokenProgram: TOKEN_PROGRAM_ID
                    })
                    .instruction()
            );
            return SolanaSwapProgram.CUCosts[isDataKey ? "CLAIM_ONCHAIN_PAY_OUT" : "CLAIM_PAY_OUT"];
        } else {
            instructions.push(
                await this.program.methods
                    .claimerClaim(secretBuffer)
                    .accounts({
                        ...accounts,
                        claimerUserData: this.SwapUserVault(swapData.claimer, swapData.token)
                    })
                    .instruction()
            );
            return SolanaSwapProgram.CUCosts[isDataKey ? "CLAIM_ONCHAIN" : "CLAIM"];
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

        if(!skipAtaCheck) computeBudget += await this.checkAtaAndIxsInitAta(swapData, initAta, instructions);
        computeBudget += await this.addIxsClaim(swapData, secret, instructions);
        computeBudget += this.checkAndAddIxsUnwrap(swapData, instructions);

        return [this.Transactions.createTransaction(instructions, computeBudget, feeRate)];
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

        const [signature] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal);
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

    /**
     * Adds instructions for writting data to a specific account
     *
     * @param accountKey
     * @param writeData
     * @param offset
     * @param sizeLimit
     * @param ixs
     * @private
     * @returns {number} bytes written to the data account
     */
    private async addIxsWriteData(
        accountKey: PublicKey,
        writeData: Buffer,
        offset: number,
        sizeLimit: number,
        ixs: TransactionInstruction[]
    ): Promise<number> {
        const writeLen = Math.min(writeData.length-offset, sizeLimit);

        ixs.push(
            await this.program.methods
                .writeData(offset, writeData.slice(offset, offset+writeLen))
                .accounts({
                    signer: this.provider.publicKey,
                    data: accountKey
                })
                .instruction()
        );

        logger.debug("addIxsWriteData(): Write partial tx data ("+offset+" .. "+(offset+writeLen)+")/"+writeData.length+
            " key: "+accountKey.toBase58());

        return writeLen;
    }

    /**
     * Adds instructions for initialization of data account
     *
     * @param accountKey
     * @param dataLength
     * @param ixs
     * @private
     */
    private async addIxsInitData(
        accountKey: PublicKey,
        dataLength: number,
        ixs: TransactionInstruction[]
    ): Promise<void> {
        const accountSize = 32+dataLength;
        const lamportsDeposit = await tryWithRetries(
            () => this.provider.connection.getMinimumBalanceForRentExemption(accountSize),
            this.retryPolicy
        );

        ixs.push(
            SystemProgram.createAccount({
                fromPubkey: this.provider.publicKey,
                newAccountPubkey: accountKey,
                lamports: lamportsDeposit,
                space: accountSize,
                programId: this.program.programId
            })
        );

        ixs.push(
            await this.program.methods
                .initData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: accountKey
                })
                .instruction()
        );
    }

    private async addTxsWriteData(
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
            const instructions: TransactionInstruction[] = [];
            await this.addIxsInitData(txDataKey.publicKey, writeData.length, instructions);
            pointer += await this.addIxsWriteData(txDataKey.publicKey, writeData, pointer, 420, instructions);

            txs.push(this.Transactions.createTransaction(
                instructions,
                SolanaSwapProgram.CUCosts.DATA_CREATE_AND_WRITE,
                feeRate, [txDataKey]
            ));
            await this.saveDataAccount(txDataKey.publicKey);
        }

        while(pointer<writeData.length) {
            const instructions: TransactionInstruction[] = [];
            pointer += await this.addIxsWriteData(txDataKey.publicKey, writeData, pointer, 950, instructions);

            txs.push(this.Transactions.createTransaction(
                instructions,
                SolanaSwapProgram.CUCosts.DATA_WRITE,
                feeRate, [txDataKey]
            ));
        }

        return txDataKey.publicKey;
    }

    private addTxsWriteTransactionData(
        tx: {hex: string, txid: string},
        vout: number,
        feeRate: string,
        txs: SolanaTx[]
    ): Promise<PublicKey> {
        const reversedTxId = Buffer.from(tx.txid, "hex").reverse();
        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            Buffer.from(tx.hex, "hex")
        ]);
        logger.debug("addTxsWriteTransactionData(): writing transaction data: ", writeData.toString("hex"));

        return this.addTxsWriteData(reversedTxId, writeData, txs, feeRate);
    }

    private async addTxsVerifyAndClaim(
        swapData: SolanaSwapData,
        storeDataKey: PublicKey,
        merkleProof: {reversedTxId: Buffer, pos: number, merkle: Buffer[]},
        commitedHeader: SolanaBtcStoredHeader,
        feeRate: string,
        txs: SolanaTx[]
    ): Promise<void> {
        const solanaTx = new Transaction();
        solanaTx.feePayer = this.provider.publicKey;

        //Verify instruction always needs to be the first one
        solanaTx.add(await this.btcRelay.createVerifyIx(merkleProof.reversedTxId, swapData.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader));
        SolanaSwapProgram.applyFeeRate(solanaTx, null, feeRate);

        //Claim instruction can be located after fee rate is applied
        const claimInstructions: TransactionInstruction[] = [];
        await this.addIxsClaim(swapData, storeDataKey, claimInstructions);
        claimInstructions.forEach(ix => solanaTx.add(ix));
        SolanaSwapProgram.applyFeeRateEnd(solanaTx, null, feeRate);

        txs.push({
            tx: solanaTx,
            signers: []
        });
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
        const shouldInitAta = await this.checkAtaExists(swapData, initAta);

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);
        logger.debug("txsClaimWithTxData(): merkle proof computed: ", merkleProof);

        const txs: SolanaTx[] = [];
        if(commitedHeader==null) commitedHeader = await this.getCommitedHeaderAndSynchronize(
            blockheight, swapData.getConfirmations(),
            tx.blockhash, txs, synchronizer
        );

        const storeDataKey = await this.addTxsWriteTransactionData(tx, vout, feeRate, txs);
        if(storageAccHolder!=null) storageAccHolder.storageAcc = storeDataKey;
        logger.debug("txsClaimWithTxData(): tx data written successfully, key: "+storeDataKey.toBase58());

        if(shouldInitAta) await this.addTxsInitAta(swapData, feeRate, txs);
        await this.addTxsVerifyAndClaim(swapData, storeDataKey, merkleProof, commitedHeader, feeRate, txs);
        if(this.checkShouldUnwrap(swapData)) this.addTxsUnwrap(swapData, feeRate, txs);

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
