import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, IdlAccounts} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    PublicKey, SendOptions,
    Signer,
} from "@solana/web3.js";
import * as createHash from "create-hash";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import * as programIdl from "./programIdl.json";
import {IStorageManager, SwapContract, ChainSwapType, TokenAddress, IntermediaryReputationType,
    SwapCommitStatus} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {RelaySynchronizer} from "crosslightning-base/dist";
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

export class SolanaSwapProgram extends SolanaProgramBase<SwapProgram> implements SwapContract<SolanaSwapData, SolanaTx, SolanaPreFetchData, SolanaPreFetchVerification> {

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
        signer: AnchorProvider & {signer?: Signer},
        btcRelay: SolanaBtcRelay<any>,
        storage: IStorageManager<StoredDataAccount>,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFees = btcRelay.Fees || new SolanaFees(signer.connection)
    ) {
        super(signer, programIdl, programAddress, retryPolicy, solanaFeeEstimator);

        this.Init = new SwapInit(this);
        this.Refund = new SwapRefund(this);
        this.Claim = new SwapClaim(this, btcRelay);
        this.DataAccount = new SolanaDataAccount(this, storage);
        this.LpVault = new SolanaLpVault(this);
    }

    async start(): Promise<void> {
        await this.DataAccount.init();
        this.logger.info("start(): sweeping old unused data accounts");
        await this.DataAccount.sweepDataAccounts();
    }

    ////////////////////////////////////////////
    //// Signatures
    preFetchForInitSignatureVerification(data: SolanaPreFetchData): Promise<SolanaPreFetchVerification> {
        return this.Init.preFetchForInitSignatureVerification(data);
    }

    preFetchBlockDataForSignatures(): Promise<SolanaPreFetchData> {
        return this.Init.preFetchBlockDataForSignatures();
    }

    getClaimInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Init.signSwapInitialization(swapData, authorizationTimeout, preFetchedBlockData, feeRate);
    }

    isValidClaimInitAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        return this.Init.isSignatureValid(swapData, timeout, prefix, signature, feeRate, preFetchedData);
    }

    getClaimInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.Init.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isClaimInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.Init.isSignatureExpired(signature, timeout);
    }

    getInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Init.signSwapInitialization(swapData, authorizationTimeout, preFetchedBlockData, feeRate);
    }

    isValidInitAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        return this.Init.isSignatureValid(swapData, timeout, prefix, signature, feeRate, preFetchedData);
    }

    getInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.Init.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.Init.isSignatureExpired(signature, timeout);
    }

    getRefundSignature(swapData: SolanaSwapData, authorizationTimeout: number): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Refund.signSwapRefund(swapData, authorizationTimeout);
    }

    isValidRefundAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {
        return this.Refund.isSignatureValid(swapData, timeout, prefix, signature);
    }

    getDataSignature(data: Buffer): Promise<string> {
        return this.Signatures.getDataSignature(data);
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        return this.Signatures.isValidDataSignature(data, signature, publicKey);
    }

    ////////////////////////////////////////////
    //// Swap data utils
    /**
     * Checks whether the claim is claimable by us, that means not expired, we are claimer & the swap is commited
     *
     * @param data
     */
    isClaimable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeClaimer(data)) return Promise.resolve(false);
        if(this.isExpired(data)) return Promise.resolve(false);
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
     * @param data
     */
    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        if(this.areWeOfferer(data)) currentTimestamp = currentTimestamp.sub(new BN(this.refundGracePeriod));
        if(this.areWeClaimer(data)) currentTimestamp = currentTimestamp.add(new BN(this.claimGracePeriod));
        return data.expiry.lt(currentTimestamp);
    }

    /**
     * Checks if the swap is refundable by us, checks if we are offerer, if the swap is already expired & if the swap
     *  is still commited
     *
     * @param data
     */
    isRequestRefundable(data: SolanaSwapData): Promise<boolean> {
        //Swap can only be refunded by the offerer
        if(!this.areWeOfferer(data)) return Promise.resolve(false);
        if(!this.isExpired(data)) return Promise.resolve(false);
        return this.isCommited(data);
    }

    /**
     * Checks whether we are claimer for a specific swap, also check the claimerAta is correct for the swap in
     *  case of payOut=true swap
     *
     * @param swapData
     */
    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            //Also check that swapData's ATA is correct
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
            if(!swapData.claimerAta.equals(ourAta)) return false;
        }
        return swapData.claimer.equals(this.provider.publicKey);
    }

    /**
     * Checks whether we are offerer for the specific swap
     *
     * @param swapData
     */
    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.provider.publicKey);
    }

    /**
     * Sets us (provider's public key) as claimer for the swap (also sets payOut=true, payIn=false & claimerAta)
     *
     * @param swapData
     */
    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.claimer = this.provider.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
    }

    /**
     * Sets us (provider's public key) as offerer for the swap (also sets payIn=true & offererAta)
     *
     * @param swapData
     */
    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.provider.publicKey;
        swapData.offererAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
        swapData.payIn = true;
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
     * @param data
     */
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
                if(!event.data.sequence.eq(data.sequence)) return null;
                return SwapCommitStatus.PAID;
            }
            if(event.name==="RefundEvent") {
                if(!event.data.sequence.eq(data.sequence)) return null;
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

    ////////////////////////////////////////////
    //// Utils
    async getBalance(token: PublicKey, inContract: boolean): Promise<BN> {
        if(inContract) return await this.getIntermediaryBalance(this.provider.publicKey.toString(), token);

        let balance = await this.Tokens.getTokenBalance(this.provider.publicKey, token);
        if(token.equals(this.Tokens.WSOL_ADDRESS)) {
            const feeCosts = new BN(5000).add(await this.getCommitFee(null));
            balance = BN.max(balance.sub(feeCosts), new BN(0));
        }
        this.logger.debug("getBalance(): token balance, token: "+token.toBase58()+" balance: "+balance.toString(10));
        return balance;
    }

    getIntermediaryData(address: string, token: PublicKey): Promise<{
        balance: BN,
        reputation: IntermediaryReputationType
    }> {
        return this.LpVault.getIntermediaryData(address, token);
    }

    getIntermediaryReputation(address: string, token: PublicKey): Promise<IntermediaryReputationType> {
        return this.LpVault.getIntermediaryReputation(address, token);
    }

    getIntermediaryBalance(address: string, token: PublicKey): Promise<BN> {
        return this.LpVault.getIntermediaryBalance(address, token);
    }

    getAddress(): string {
        return this.Addresses.getAddress();
    }

    isValidAddress(address: string): boolean {
        return this.Addresses.isValidAddress(address);
    }

    getNativeCurrencyAddress(): TokenAddress {
        return this.Tokens.getNativeCurrencyAddress();
    }

    toTokenAddress(address: string): TokenAddress {
        return this.Tokens.toTokenAddress(address);
    }

    ////////////////////////////////////////////
    //// Transaction initializers
    async txsClaimWithSecret(
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        feeRate?: string,
        skipAtaCheck?: boolean
    ): Promise<SolanaTx[]> {
        return this.Claim.txsClaimWithSecret(swapData, secret, checkExpiry, initAta, feeRate, skipAtaCheck)
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
        return this.Claim.txsClaimWithTxData(swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, storageAccHolder, feeRate);
    }

    txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefund(swapData, check, initAta, feeRate);
    }

    txsRefundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);
    }

    txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInitPayIn(swapData, timeout, prefix, signature, skipChecks, feeRate);
    }

    txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInit(swapData, timeout, prefix, signature, skipChecks, feeRate);
    }

    txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsWithdraw(token, amount, feeRate);
    }

    txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsDeposit(token, amount, feeRate);
    }

    txsTransfer(token: TokenAddress, amount: BN, dstAddress: string): Promise<SolanaTx[]> {
        return this.Tokens.txsTransfer(token, amount, dstAddress);
    }

    ////////////////////////////////////////////
    //// Executors
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
        return signature;
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

        //TODO: This doesn't return proper tx signature
        const [signature] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal);
        await this.DataAccount.removeDataAccount(data.storageAcc);

        return signature;
    }

    async refund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefund(swapData, check, initAta, feeRate);

        const [signature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signature;
    }

    async refundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInitPayIn(swapData,timeout,prefix,signature,skipChecks,feeRate);

        const signatures = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signatures[signatures.length-1];
    }

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInit(swapData,timeout,prefix,signature,txoHash,skipChecks,feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string[]> {
        const txsCommit = await this.txsInit(swapData, timeout, prefix, signature, null, skipChecks, feeRate);
        const txsClaim = await this.txsClaimWithSecret(swapData, secret, true, false, feeRate, true);

        return await this.Transactions.sendAndConfirm(txsCommit.concat(txsClaim), waitForConfirmation, abortSignal);
    }

    async withdraw(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsWithdraw(token, amount, feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    async deposit(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsDeposit(token, amount, feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    async transfer(token: TokenAddress, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    ////////////////////////////////////////////
    //// Transactions
    sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        return this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, parallel, onBeforePublish);
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
    getInitPayInFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {
        return this.Init.getInitPayInFeeRate(offerer, claimer, token, paymentHash);
    }

    getInitFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {
        return this.Init.getInitFeeRate(offerer, claimer, token, paymentHash);
    }

    getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {
        return this.Refund.getRefundFeeRate(swapData);
    }

    getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {
        return this.Claim.getClaimFeeRate(swapData);
    }

    getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getClaimFee(swapData, feeRate);
    }

    getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getRawClaimFee(swapData, feeRate);
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

}
