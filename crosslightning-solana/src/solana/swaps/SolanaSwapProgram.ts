import {SolanaSwapData} from "./SolanaSwapData";
import {IdlAccounts} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    Connection, Keypair,
    PublicKey,
    SendOptions
} from "@solana/web3.js";
import * as createHash from "create-hash";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import * as programIdl from "./programIdl.json";
import {
    IStorageManager, SwapContract, ChainSwapType, IntermediaryReputationType,
    SwapCommitStatus, TransactionConfirmationOptions, SignatureData, RelaySynchronizer
} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {SolanaFees} from "../base/modules/SolanaFees";
import {SwapProgram} from "./programTypes";
import {SolanaRetryPolicy} from "../base/SolanaBase";
import {SolanaProgramBase} from "../program/SolanaProgramBase";
import {SolanaTx} from "../base/modules/SolanaTransactions";
import {SwapInit, SolanaPreFetchData, SolanaPreFetchVerification} from "./modules/SwapInit";
import {SolanaDataAccount, StoredDataAccount} from "./modules/SolanaDataAccount";
import {SwapRefund} from "./modules/SwapRefund";
import {SwapClaim} from "./modules/SwapClaim";
import {SolanaLpVault} from "./modules/SolanaLpVault";
import {Buffer} from "buffer";
import {SolanaSigner} from "../wallet/SolanaSigner";
import {SolanaKeypairWallet} from "../wallet/SolanaKeypairWallet";

function toPublicKeyOrNull(str: string | null): PublicKey | null {
    return str==null ? null : new PublicKey(str);
}

export class SolanaSwapProgram
    extends SolanaProgramBase<SwapProgram>
    implements SwapContract<
        SolanaSwapData,
        SolanaTx,
        SolanaPreFetchData,
        SolanaPreFetchVerification,
        SolanaSigner,
        "SOLANA"
    > {

    ////////////////////////
    //// Constants
    public readonly ESCROW_STATE_RENT_EXEMPT = 2658720;

    ////////////////////////
    //// PDA accessors
    readonly SwapVaultAuthority = this.pda("authority");
    readonly SwapVault = this.pda("vault", (tokenAddress: PublicKey) => [tokenAddress.toBuffer()]);
    readonly SwapUserVault = this.pda("uservault",
        (publicKey: PublicKey, tokenAddress: PublicKey) => [publicKey.toBuffer(), tokenAddress.toBuffer()]
    );
    readonly SwapEscrowState = this.pda("state", (hash: Buffer) => [hash]);

    ////////////////////////
    //// Timeouts
    readonly chainId: "SOLANA" = "SOLANA";
    readonly claimWithSecretTimeout: number = 45;
    readonly claimWithTxDataTimeout: number = 120;
    readonly refundTimeout: number = 45;
    readonly claimGracePeriod: number = 10*60;
    readonly refundGracePeriod: number = 10*60;
    readonly authGracePeriod: number = 5*60;

    ////////////////////////
    //// Services
    readonly Init: SwapInit;
    readonly Refund: SwapRefund;
    readonly Claim: SwapClaim;
    readonly DataAccount: SolanaDataAccount;
    readonly LpVault: SolanaLpVault;

    constructor(
        connection: Connection,
        btcRelay: SolanaBtcRelay<any>,
        storage: IStorageManager<StoredDataAccount>,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFees = btcRelay.Fees || new SolanaFees(connection)
    ) {
        super(connection, programIdl, programAddress, retryPolicy, solanaFeeEstimator);

        this.Init = new SwapInit(this);
        this.Refund = new SwapRefund(this);
        this.Claim = new SwapClaim(this, btcRelay);
        this.DataAccount = new SolanaDataAccount(this, storage);
        this.LpVault = new SolanaLpVault(this);
    }

    async start(): Promise<void> {
        await this.DataAccount.init();
    }

    getClaimableDeposits(signer: string): Promise<{count: number, totalValue: BN}> {
        return this.DataAccount.getDataAccountsInfo(new PublicKey(signer));
    }

    claimDeposits(signer: SolanaSigner): Promise<{txIds: string[], count: number, totalValue: BN}> {
        return this.DataAccount.sweepDataAccounts(signer);
    }

    ////////////////////////////////////////////
    //// Signatures
    preFetchForInitSignatureVerification(data: SolanaPreFetchData): Promise<SolanaPreFetchVerification> {
        return this.Init.preFetchForInitSignatureVerification(data);
    }

    preFetchBlockDataForSignatures(): Promise<SolanaPreFetchData> {
        return this.Init.preFetchBlockDataForSignatures();
    }

    getInitSignature(signer: SolanaSigner, swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<SignatureData> {
        return this.Init.signSwapInitialization(signer, swapData, authorizationTimeout, preFetchedBlockData, feeRate);
    }

    isValidInitAuthorization(swapData: SolanaSwapData, {timeout, prefix, signature}, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        return this.Init.isSignatureValid(swapData, timeout, prefix, signature, feeRate, preFetchedData);
    }

    getInitAuthorizationExpiry(swapData: SolanaSwapData, {timeout, prefix, signature}, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.Init.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isInitAuthorizationExpired(swapData: SolanaSwapData, {timeout, prefix, signature}): Promise<boolean> {
        return this.Init.isSignatureExpired(signature, timeout);
    }

    getRefundSignature(signer: SolanaSigner, swapData: SolanaSwapData, authorizationTimeout: number): Promise<SignatureData> {
        return this.Refund.signSwapRefund(signer, swapData, authorizationTimeout);
    }

    isValidRefundAuthorization(swapData: SolanaSwapData, {timeout, prefix, signature}): Promise<Buffer> {
        return this.Refund.isSignatureValid(swapData, timeout, prefix, signature);
    }

    getDataSignature(signer: SolanaSigner, data: Buffer): Promise<string> {
        return this.Signatures.getDataSignature(signer, data);
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        return this.Signatures.isValidDataSignature(data, signature, publicKey);
    }

    ////////////////////////////////////////////
    //// Swap data utils
    /**
     * Checks whether the claim is claimable by us, that means not expired, we are claimer & the swap is commited
     *
     * @param signer
     * @param data
     */
    isClaimable(signer: string, data: SolanaSwapData): Promise<boolean> {
        if(!data.isClaimer(signer)) return Promise.resolve(false);
        if(this.isExpired(signer, data)) return Promise.resolve(false);
        return this.isCommited(data);
    }

    /**
     * Checks whether a swap is commited, i.e. the swap still exists on-chain and was not claimed nor refunded
     *
     * @param swapData
     */
    async isCommited(swapData: SolanaSwapData): Promise<boolean> {
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return false;

        return swapData.correctPDA(account);
    }

    /**
     * Checks whether the swap is expired, takes into consideration possible on-chain time skew, therefore for claimer
     *  the swap expires a bit sooner than it should've & for the offerer it expires a bit later
     *
     * @param signer
     * @param data
     */
    isExpired(signer: string, data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        if(data.isClaimer(signer)) currentTimestamp = currentTimestamp.sub(new BN(this.refundGracePeriod));
        if(data.isOfferer(signer)) currentTimestamp = currentTimestamp.add(new BN(this.claimGracePeriod));
        return data.expiry.lt(currentTimestamp);
    }

    /**
     * Checks if the swap is refundable by us, checks if we are offerer, if the swap is already expired & if the swap
     *  is still commited
     *
     * @param signer
     * @param data
     */
    isRequestRefundable(signer: string, data: SolanaSwapData): Promise<boolean> {
        //Swap can only be refunded by the offerer
        if(!data.isOfferer(signer)) return Promise.resolve(false);
        if(!this.isExpired(signer, data)) return Promise.resolve(false);
        return this.isCommited(data);
    }

    /**
     * Get the swap payment hash to be used for an on-chain swap, this just uses a sha256 hash of the values
     *
     * @param outputScript output script required to claim the swap
     * @param amount sats sent required to claim the swap
     * @param nonce swap nonce uniquely identifying the transaction to prevent replay attacks
     */
    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer {
        return createHash("sha256").update(Buffer.concat([
            Buffer.from(nonce.toArray("le", 8)),
            Buffer.from(amount.toArray("le", 8)),
            outputScript
        ])).digest();
    }

    ////////////////////////////////////////////
    //// Swap data getters
    /**
     * Gets the status of the specific swap, this also checks if we are offerer/claimer & checks for expiry (to see
     *  if swap is refundable)
     *
     * @param signer
     * @param data
     */
    async getCommitStatus(signer: string, data: SolanaSwapData): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        const escrowState: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            if(data.correctPDA(escrowState)) {
                if(data.isOfferer(signer) && this.isExpired(signer,data)) return SwapCommitStatus.REFUNDABLE;
                return SwapCommitStatus.COMMITED;
            }

            if(data.isOfferer(signer) && this.isExpired(signer, data)) return SwapCommitStatus.EXPIRED;
            return SwapCommitStatus.NOT_COMMITED;
        }

        //Check if paid or what
        const status = await this.Events.findInEvents(escrowStateKey, async (event) => {
            if(event.name==="ClaimEvent") {
                if(!event.data.sequence.eq(data.sequence)) return null;
                return SwapCommitStatus.PAID;
            }
            if(event.name==="RefundEvent") {
                if(!event.data.sequence.eq(data.sequence)) return null;
                if(this.isExpired(signer, data)) return SwapCommitStatus.EXPIRED;
                return SwapCommitStatus.NOT_COMMITED;
            }
        });
        if(status!=null) return status;

        if(this.isExpired(signer, data)) {
            return SwapCommitStatus.EXPIRED;
        }
        return SwapCommitStatus.NOT_COMMITED;
    }

    /**
     * Checks the status of the specific payment hash
     *
     * @param paymentHash
     */
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
     * Returns the data committed for a specific payment hash, or null if no data is currently commited for
     *  the specific swap
     *
     * @param paymentHashHex
     */
    async getCommitedData(paymentHashHex: string): Promise<SolanaSwapData> {
        const paymentHash = Buffer.from(paymentHashHex, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return null;

        return SolanaSwapData.fromEscrowState(account);
    }

    ////////////////////////////////////////////
    //// Swap data initializer
    createSwapData(
        type: ChainSwapType,
        offerer: string,
        claimer: string,
        token: string,
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
        const tokenAddr: PublicKey = new PublicKey(token);
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
            offererKey==null ? null : payIn ? getAssociatedTokenAddressSync(tokenAddr, offererKey) : PublicKey.default,
            claimerKey==null ? null : payOut ? getAssociatedTokenAddressSync(tokenAddr, claimerKey) : PublicKey.default,
            securityDeposit,
            claimerBounty,
            null
        ));
    }

    ////////////////////////////////////////////
    //// Utils
    async getBalance(signer: string, tokenAddress: string, inContract: boolean): Promise<BN> {
        const token = new PublicKey(tokenAddress);
        const publicKey = new PublicKey(signer);

        if(inContract) return await this.getIntermediaryBalance(publicKey, token);

        let balance = await this.Tokens.getTokenBalance(publicKey, token);
        if(token.equals(this.Tokens.WSOL_ADDRESS)) {
            const feeCosts = new BN(5000).add(await this.getCommitFee(null));
            balance = BN.max(balance.sub(feeCosts), new BN(0));
        }
        this.logger.debug("getBalance(): token balance, token: "+token.toBase58()+" balance: "+balance.toString(10));
        return balance;
    }

    getIntermediaryData(address: string, token: string): Promise<{
        balance: BN,
        reputation: IntermediaryReputationType
    }> {
        return this.LpVault.getIntermediaryData(new PublicKey(address), new PublicKey(token));
    }

    getIntermediaryReputation(address: string, token: string): Promise<IntermediaryReputationType> {
        return this.LpVault.getIntermediaryReputation(new PublicKey(address), new PublicKey(token));
    }

    getIntermediaryBalance(address: PublicKey, token: PublicKey): Promise<BN> {
        return this.LpVault.getIntermediaryBalance(address, token);
    }

    isValidAddress(address: string): boolean {
        return this.Addresses.isValidAddress(address);
    }

    getNativeCurrencyAddress(): string {
        return this.Tokens.getNativeCurrencyAddress().toString();
    }

    ////////////////////////////////////////////
    //// Transaction initializers
    async txsClaimWithSecret(
        signer: string | SolanaSigner,
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        feeRate?: string,
        skipAtaCheck?: boolean
    ): Promise<SolanaTx[]> {
        return this.Claim.txsClaimWithSecret(typeof(signer)==="string" ? new PublicKey(signer) : signer.getPublicKey(), swapData, secret, checkExpiry, initAta, feeRate, skipAtaCheck)
    }

    async txsClaimWithTxData(
        signer: string | SolanaSigner,
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        feeRate?: string,
        storageAccHolder?: {storageAcc: PublicKey}
    ): Promise<SolanaTx[] | null> {
        return this.Claim.txsClaimWithTxData(typeof(signer)==="string" ? new PublicKey(signer) : signer, swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, storageAccHolder, feeRate);
    }

    txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefund(swapData, check, initAta, feeRate);
    }

    txsRefundWithAuthorization(swapData: SolanaSwapData, {timeout, prefix, signature}, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);
    }

    txsInitPayIn(swapData: SolanaSwapData, {timeout, prefix, signature}, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInitPayIn(swapData, timeout, prefix, signature, skipChecks, feeRate);
    }

    txsInit(swapData: SolanaSwapData, {timeout, prefix, signature}, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInit(swapData, timeout, prefix, signature, skipChecks, feeRate);
    }

    txsWithdraw(signer: string, token: string, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsWithdraw(new PublicKey(signer), new PublicKey(token), amount, feeRate);
    }

    txsDeposit(signer: string, token: string, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsDeposit(new PublicKey(signer), new PublicKey(token), amount, feeRate);
    }

    txsTransfer(signer: string, token: string, amount: BN, dstAddress: string, feeRate?: string): Promise<SolanaTx[]> {
        return this.Tokens.txsTransfer(new PublicKey(signer), new PublicKey(token), amount, new PublicKey(dstAddress), feeRate);
    }

    ////////////////////////////////////////////
    //// Executors
    async claimWithSecret(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        const result = await this.Claim.txsClaimWithSecret(signer.getPublicKey(), swapData, secret, checkExpiry, initAta, txOptions?.feeRate);
        const [signature] = await this.Transactions.sendAndConfirm(signer, result, txOptions?.waitForConfirmation, txOptions?.abortSignal);
        return signature;
    }

    async claimWithTxData(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        const data: {storageAcc: PublicKey} = {
            storageAcc: null
        };

        const txs = await this.Claim.txsClaimWithTxData(
            signer, swapData, blockheight, tx, vout,
            commitedHeader, synchronizer, initAta, data, txOptions?.feeRate
        );
        if(txs===null) throw new Error("Btc relay not synchronized to required blockheight!");

        //TODO: This doesn't return proper tx signature
        const [signature] = await this.Transactions.sendAndConfirm(signer, txs, txOptions?.waitForConfirmation, txOptions?.abortSignal);
        await this.DataAccount.removeDataAccount(data.storageAcc);

        return signature;
    }

    async refund(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        check?: boolean,
        initAta?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        if(!signer.getPublicKey().equals(swapData.offerer)) throw new Error("Invalid signer provided!");

        let result = await this.txsRefund(swapData, check, initAta, txOptions?.feeRate);

        const [signature] = await this.Transactions.sendAndConfirm(signer, result, txOptions?.waitForConfirmation, txOptions?.abortSignal);

        return signature;
    }

    async refundWithAuthorization(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        signature: SignatureData,
        check?: boolean,
        initAta?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        if(!signer.getPublicKey().equals(swapData.offerer)) throw new Error("Invalid signer provided!");

        let result = await this.txsRefundWithAuthorization(swapData, signature, check, initAta, txOptions?.feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(signer, result, txOptions?.waitForConfirmation, txOptions?.abortSignal);

        return txSignature;
    }

    async initPayIn(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        signature: SignatureData,
        skipChecks?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        if(!signer.getPublicKey().equals(swapData.offerer)) throw new Error("Invalid signer provided!");

        let result = await this.txsInitPayIn(swapData, signature, skipChecks, txOptions?.feeRate);

        const signatures = await this.Transactions.sendAndConfirm(signer, result, txOptions?.waitForConfirmation, txOptions?.abortSignal);

        return signatures[signatures.length-1];
    }

    async init(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        signature: SignatureData,
        txoHash?: Buffer,
        skipChecks?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        if(!signer.getPublicKey().equals(swapData.claimer)) throw new Error("Invalid signer provided!");

        let result = await this.txsInit(swapData, signature, txoHash, skipChecks, txOptions?.feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(signer, result, txOptions?.waitForConfirmation, txOptions?.abortSignal);

        return txSignature;
    }

    async initAndClaimWithSecret(
        signer: SolanaSigner,
        swapData: SolanaSwapData,
        signature: SignatureData,
        secret: string,
        skipChecks?: boolean,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string[]> {
        if(!signer.getPublicKey().equals(swapData.claimer)) throw new Error("Invalid signer provided!");

        const txsCommit = await this.txsInit(swapData, signature, null, skipChecks, txOptions?.feeRate);
        const txsClaim = await this.Claim.txsClaimWithSecret(signer.getPublicKey(), swapData, secret, true, false, txOptions?.feeRate, true);

        return await this.Transactions.sendAndConfirm(signer, txsCommit.concat(txsClaim), txOptions?.waitForConfirmation, txOptions?.abortSignal);
    }

    async withdraw(
        signer: SolanaSigner,
        token: string,
        amount: BN,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        const txs = await this.LpVault.txsWithdraw(signer.getPublicKey(), new PublicKey(token), amount, txOptions?.feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(signer, txs, txOptions?.waitForConfirmation, txOptions?.abortSignal, false);
        return txId;
    }

    async deposit(
        signer: SolanaSigner,
        token: string,
        amount: BN,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        const txs = await this.LpVault.txsDeposit(signer.getPublicKey(), new PublicKey(token), amount, txOptions?.feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(signer, txs, txOptions?.waitForConfirmation, txOptions?.abortSignal, false);
        return txId;
    }

    async transfer(
        signer: SolanaSigner,
        token: string,
        amount: BN,
        dstAddress: string,
        txOptions?: TransactionConfirmationOptions
    ): Promise<string> {
        const txs = await this.Tokens.txsTransfer(signer.getPublicKey(), new PublicKey(token), amount, new PublicKey(dstAddress), txOptions?.feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(signer, txs, txOptions?.waitForConfirmation, txOptions?.abortSignal, false);
        return txId;
    }

    ////////////////////////////////////////////
    //// Transactions
    sendAndConfirm(
        signer: SolanaSigner,
        txs: SolanaTx[],
        waitForConfirmation?: boolean,
        abortSignal?: AbortSignal,
        parallel?: boolean,
        onBeforePublish?: (txId: string, rawTx: string) => Promise<void>
    ): Promise<string[]> {
        return this.Transactions.sendAndConfirm(signer, txs, waitForConfirmation, abortSignal, parallel, onBeforePublish);
    }

    serializeTx(tx: SolanaTx): Promise<string> {
        return this.Transactions.serializeTx(tx);
    }

    deserializeTx(txData: string): Promise<SolanaTx> {
        return this.Transactions.deserializeTx(txData);
    }

    getTxIdStatus(txId: string): Promise<"not_found" | "pending" | "success" | "reverted"> {
        return this.Transactions.getTxIdStatus(txId);
    }

    getTxStatus(tx: string): Promise<"not_found" | "pending" | "success" | "reverted"> {
        return this.Transactions.getTxStatus(tx);
    }

    ////////////////////////////////////////////
    //// Fees
    getInitPayInFeeRate(offerer?: string, claimer?: string, token?: string, paymentHash?: string): Promise<string> {
        return this.Init.getInitPayInFeeRate(
            toPublicKeyOrNull(offerer),
            toPublicKeyOrNull(claimer),
            toPublicKeyOrNull(token),
            paymentHash
        );
    }

    getInitFeeRate(offerer?: string, claimer?: string, token?: string, paymentHash?: string): Promise<string> {
        return this.Init.getInitFeeRate(
            toPublicKeyOrNull(offerer),
            toPublicKeyOrNull(claimer),
            toPublicKeyOrNull(token),
            paymentHash
        );
    }

    getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {
        return this.Refund.getRefundFeeRate(swapData);
    }

    getClaimFeeRate(signer: string, swapData: SolanaSwapData): Promise<string> {
        return this.Claim.getClaimFeeRate(new PublicKey(signer), swapData);
    }

    getClaimFee(signer: string, swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getClaimFee(new PublicKey(signer), swapData, feeRate);
    }

    getRawClaimFee(signer: string, swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getRawClaimFee(new PublicKey(signer), swapData, feeRate);
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Init.getInitFee(swapData, feeRate);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Refund.getRefundFee(swapData, feeRate);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRawRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Refund.getRawRefundFee(swapData, feeRate);
    }

    ///////////////////////////////////
    //// Callbacks & handlers
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean {
        return true;
    }

    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void {}

    onBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): void {
        this.Transactions.onBeforeTxSigned(callback);
    }

    offBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): boolean {
        return this.Transactions.offBeforeTxSigned(callback);
    }

    onSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): void {
        this.Transactions.onSendTransaction(callback);
    }

    offSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): boolean {
        return this.Transactions.offSendTransaction(callback);
    }

    isValidToken(tokenIdentifier: string): boolean {
        try {
            new PublicKey(tokenIdentifier);
            return true;
        } catch (e) {
            return false;
        }
    }

    randomAddress(): string {
        return Keypair.generate().publicKey.toString();
    }

    randomSigner(): SolanaSigner {
        const keypair = Keypair.generate();
        const wallet = new SolanaKeypairWallet(keypair);
        return new SolanaSigner(wallet, keypair);
    }

}
