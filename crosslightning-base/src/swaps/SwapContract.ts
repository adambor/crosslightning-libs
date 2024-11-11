import {SwapData} from "./SwapData";
import * as BN from "bn.js";
import {BtcStoredHeader} from "../btcrelay/types/BtcStoredHeader";
import {SwapCommitStatus} from "./SwapCommitStatus";
import {ChainSwapType} from "./ChainSwapType";
import {RelaySynchronizer} from "../btcrelay/synchronizer/RelaySynchronizer";

export type IntermediaryReputationType = {
    [key in ChainSwapType]: {
        successVolume: BN,
        successCount: BN,
        failVolume: BN,
        failCount: BN,
        coopCloseVolume: BN,
        coopCloseCount: BN,
    }
};

export type SignatureData = {
    prefix: string,
    timeout: string,
    signature: string
};

export type BitcoinTransactionData = {
    blockhash: string,
    confirmations: number,
    txid: string,
    hex: string
};

export type TransactionConfirmationOptions = {
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal,
    feeRate?: string
};

export type AbstractSigner = {
    getAddress: () => string
};

export interface SwapContract<
    T extends SwapData = SwapData,
    TX = any,
    PreFetchData = any,
    PreFetchVerification = any,
    Signer extends AbstractSigner = AbstractSigner,
    ChainId extends string = string
> {

    readonly chainId: ChainId;
    readonly claimWithSecretTimeout: number;
    readonly claimWithTxDataTimeout: number;
    readonly refundTimeout: number;

    /**
     * Initializes the swap contract
     */
    start(): Promise<void>;

    /**
     * Signs & sends transactions for initializing a payIn swap (SC -> BTC)
     *
     * @param signer Signer to use for the transaction (must match offerer in swap data)
     * @param swapData Swap to init
     * @param signature Signature data from the claimer
     * @param skipChecks Whether to skip verification of the signature & checking if the swap is already committed
     * @param txOptions Transaction options
     */
    initPayIn(signer: Signer, swapData: T, signature: SignatureData, skipChecks?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the unsigned transactions required for initializing a payIn swap (SC -> BTC)
     *
     * @param swapData Swap to init
     * @param signature Signature data from the claimer
     * @param skipChecks Whether to skip verification of the signature & checking if the swap is already committed
     * @param feeRate Fee rate to use for the transaction
     */
    txsInitPayIn(swapData: T, signature: SignatureData, skipChecks?: boolean, feeRate?: string): Promise<TX[]>;

    /**
     * Signs & sends transactions for initializing a non-payIn swap (BTC -> SC)
     *
     * @param signer Signer to use for the transaction (must match claimer in swap data)
     * @param swapData Swap to init
     * @param signature Signature data from the offerer
     * @param txoHash Tx output hash to use for BTC -> SC (on-chain) swaps to allow watchtowers to claim swaps
     * @param skipChecks Whether to skip verification of the signature & checking if the swap is already committed
     * @param txOptions Transaction options
     */
    init(signer: Signer, swapData: T, signature: SignatureData, txoHash?: Buffer, skipChecks?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the unsigned transactions required for initializing a non-payIn swap (BTC -> SC)
     *
     * @param swapData Swap to init
     * @param signature Signature data from the offerer
     * @param txoHash Tx output hash to use for BTC -> SC (on-chain) swaps to allow watchtowers to claim swaps
     * @param skipChecks Whether to skip verification of the signature & checking if the swap is already committed
     * @param feeRate Fee rate to use for the transaction
     */
    txsInit(swapData: T, signature: SignatureData, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<TX[]>;

    /**
     * Signs & sends transactions required for claiming an HTLC swap
     *
     * @param signer Signer for which the transaction should be created (doesn't need to match the claimer)
     * @param swapData Swap to claim
     * @param secret Secret pre-image that hashes to the swap hash
     * @param checkExpiry Whether to check expiration of the swap before executing transactions
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param txOptions Transaction options
     */
    claimWithSecret(signer: Signer, swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the unsigned transactions required for claiming an HTLC swap
     *
     * @param signer Signer for which the transaction should be created (doesn't need to match the claimer)
     * @param swapData Swap to claim
     * @param secret Secret pre-image that hashes to the swap hash
     * @param checkExpiry Whether to check expiration of the swap before returning the transactions
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param feeRate Fee rate to use for the transactions
     * @param skipAtaCheck Whether to skip checking if token account exists
     */
    txsClaimWithSecret(signer: string | Signer, swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: string, skipAtaCheck?: boolean): Promise<TX[]>;

    /**
     * Signs & sends transactions required for claiming an on-chain PTLC (proof-time locked contract) swap
     *
     * @param signer Signer for which the transaction should be created (doesn't need to match the claimer)
     * @param swapData Swap to claim
     * @param blockheight Blockheight of the bitcoin block which includes the transaction
     * @param tx Bitcoin transaction containing the required output
     * @param vout Bitcoin tx's output index of the required output
     * @param storedHeader Optional already retrieved stored header to use for proving
     * @param synchronizer Optiona synchronizer to be used if BTC relay contract is not synced up to the required blockheight
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param txOptions Transaction options
     */
    claimWithTxData(signer: Signer, swapData: T, blockheight: number, tx: BitcoinTransactionData, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the unsigned transactions required for claiming an on-chain PTLC (proof-time locked contract) swap
     *
     * @param signer Signer for which the transaction should be created (doesn't need to match the claimer)
     * @param swapData Swap to claim
     * @param blockheight Blockheight of the bitcoin block which includes the transaction
     * @param tx Bitcoin transaction containing the required output
     * @param vout Bitcoin tx's output index of the required output
     * @param storedHeader Optional already retrieved stored header to use for proving
     * @param synchronizer Optiona synchronizer to be used if BTC relay contract is not synced up to the required blockheight
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param feeRate Fee rate to use for the transactions
     */
    txsClaimWithTxData(signer: string | Signer, swapData: T, blockheight: number, tx: BitcoinTransactionData, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, feeRate?: string): Promise<TX[]>;

    /**
     * Signs & sends transactions for refunding a timed out swap
     *
     * @param signer Signer to use for the transaction (must match offerer in swap data)
     * @param swapData Swap to refund
     * @param check Whether to check if the swap contract still exists on-chain
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param txOptions Transaction options
     */
    refund(signer: Signer, swapData: T, check?: boolean, initAta?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the transactions for refunding a timed out swap
     *
     * @param swapData Swap to refund
     * @param check Whether to check if the swap contract still exists on-chain
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param feeRate Fee rate to use for the transactions
     */
    txsRefund(swapData: T, check?: boolean, initAta?: boolean, feeRate?: string): Promise<TX[]>;

    /**
     * Signs & sends transactions for refunding a swap with a valid refund signature from the claimer
     *
     * @param signer Signer to use for the transaction (must match offerer in swap data)
     * @param swapData Swap to refund
     * @param signature Refund signature received from the claimer
     * @param check Whether to check if the swap contract still exists on-chain
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param txOptions Transaction options
     */
    refundWithAuthorization(signer: Signer, swapData: T, signature: SignatureData, check?: boolean, initAta?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns the transactions for refunding a swap with a valid refund signature from the claimer
     *
     * @param swapData Swap to refund
     * @param signature Refund signature received from the claimer
     * @param check Whether to check if the swap contract still exists on-chain
     * @param initAta Whether to initialize a token account if it doesn't exist (applies to e.g. Solana, with token specific ATAs)
     * @param feeRate Fee rate to use for the transactions
     */
    txsRefundWithAuthorization(swapData: T, signature: SignatureData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<TX[]>;

    /**
     * Signs & sends transactions for initializing and instantly (upon init confirmation) claiming the HTLC, used for BTC-LN -> SC swaps
     *
     * @param signer Signer to use for the transaction (must match claimer in swap data)
     * @param swapData Swap to process
     * @param signature Signature data from the offerer
     * @param secret Secret pre-image that hashes to the swap hash
     * @param skipChecks Whether to skip verification of the signature & checking if the swap is already committed
     * @param txOptions Transaction options
     */
    initAndClaimWithSecret(signer: Signer, swapData: T, signature: SignatureData, secret: string, skipChecks?: boolean, txOptions?: TransactionConfirmationOptions): Promise<string[]>;

    /**
     * Checks whether a swap is already expired, swap expires a bit sooner for the claimer & a bit later for offerer, this
     *  is used to account for possible on-chain time skew
     *
     * @param signer Signer to use for checking the expiry
     * @param swapData Swap to check
     */
    isExpired(signer: string, swapData: T): boolean;

    /**
     * Checks whether a swap is claimable for the signer, i.e. it is not expired yet and is committed on-chain
     *
     * @param signer
     * @param swapData
     */
    isClaimable(signer: string, swapData: T): Promise<boolean>;

    /**
     * Checks whether a given swap is committed on chain (initialized)
     *
     * @param swapData
     */
    isCommited(swapData: T): Promise<boolean>;

    /**
     * Returns the full status of the swap, expiry is handler by the isExpired function so also requires a signer
     *
     * @param signer
     * @param swapData
     */
    getCommitStatus(signer: string, swapData: T): Promise<SwapCommitStatus>;

    /**
     * Returns the full status of the swap as identified by its payment hash
     *
     * @param paymentHash
     */
    getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus>;

    /**
     * Returns the on-chain committed data for the swap as identifier by its payment hash, NOTE: this might be slow & expensive
     *  for EVM chains due to the need to go through all the events
     *
     * @param paymentHash
     */
    getCommitedData(paymentHash: string): Promise<T>;

    /**
     * Checks whether a given swap is refundable by us, i.e. it is already expired, we are offerer & swap is committed on-chain
     *
     * @param signer
     * @param swapData
     */
    isRequestRefundable(signer: string, swapData: T): Promise<boolean>;

    /**
     * Pre-fetches data required for creating init signature
     */
    preFetchBlockDataForSignatures?(): Promise<PreFetchData>;

    /**
     * Pre-fetches data required for init signature verification
     * @param data
     */
    preFetchForInitSignatureVerification?(data: PreFetchData): Promise<PreFetchVerification>;

    /**
     * Generates the initialization signature
     *
     * @param signer Signer to use for signing the message
     * @param swapData Swap to sign
     * @param authorizationTimeout Timeout of the authorization
     * @param preFetchedBlockData Optional pre-fetched data required for creating the signature
     * @param feeRate Optional fee rate to use for the authorization
     */
    getInitSignature(signer: Signer, swapData: T, authorizationTimeout: number, preFetchedBlockData?: PreFetchData, feeRate?: string): Promise<SignatureData>;

    /**
     * Checks whether a signature is a valid initialization signature for a given swap
     *
     * @param swapData Swap to initialize
     * @param signature Signature data
     * @param feeRate Fee rate used for the authorization
     * @param preFetchedVerificationData Optional pre-fetched data required for signature validation
     * @returns {Buffer | null} The message being signed if valid or null if invalid signature
     */
    isValidInitAuthorization(swapData: T, signature: SignatureData, feeRate?: string, preFetchedVerificationData?: PreFetchVerification): Promise<Buffer | null>;

    /**
     * Returns the expiry timestamp (UNIX milliseconds) of the authorization
     *
     * @param swapData Swap
     * @param signature Signature data
     * @param preFetchedVerificationData Optional pre-fetched data required for signature validation
     */
    getInitAuthorizationExpiry(swapData: T, signature: SignatureData, preFetchedVerificationData?: PreFetchVerification): Promise<number>;

    /**
     * Checks whether a given init signature is already expired
     *
     * @param swapData Swap
     * @param signature Signature data
     */
    isInitAuthorizationExpired(swapData: T, signature: SignatureData): Promise<boolean>;

    /**
     * Generates the refund signature for a given swap allowing the offerer to refund before expiration
     *
     * @param signer Signer to use for signing the message (must be the same as offerer in swap data)
     * @param swapData Swap to refund
     * @param authorizationTimeout Timeout of the provided refund authorization
     */
    getRefundSignature(signer: Signer, swapData: T, authorizationTimeout: number): Promise<SignatureData>;

    /**
     * Checks whether a given refund signature is valid
     *
     * @param swapData Swap to refund
     * @param signature Signature received from the claimer
     */
    isValidRefundAuthorization(swapData: T, signature: SignatureData): Promise<Buffer | null>;

    /**
     * Signs the given data with the provided signer
     *
     * @param signer Signer to sign the message
     * @param data Data to sign
     */
    getDataSignature(signer: Signer, data: Buffer): Promise<string>;

    /**
     * Checks whether a provided data is signature is valid
     *
     * @param data Data to sign
     * @param signature Signature
     * @param publicKey Public key of the signer
     */
    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean>;

    /**
     * Returns the token balance of a given signer's address
     *
     * @param signer Address to check the balance of
     * @param token Token
     * @param inContract Whether we are checking the liquidity deposited into the LP vault or just on-chain balance
     */
    getBalance(signer: string, token: string, inContract: boolean): Promise<BN>;

    /**
     * Create a swap data for this given chain
     *
     * @param type Type of the swap
     * @param offerer Offerer address
     * @param claimer Claimer addres
     * @param token Token to use for the swap
     * @param amount Amount of tokens for the swap
     * @param paymentHash Payment hash identifying the swap
     * @param sequence Swap sequence uniquelly defining this swap
     * @param expiry Expiration of the swap
     * @param escrowNonce Nonce to be used for replay protection of BTC transactions
     * @param confirmations Required transaction on-chain confirmation for BTC on-chain swaps
     * @param payIn Whether the swap is payIn (offerer paying to the contract, or not payIn offerer using funds in his LP vault)
     * @param payOut Whether the swap is payOut (claimer getting the funds to his on-chain address, or no payOut claimer
     *  getting his funds into his LP vault)
     * @param securityDeposit Security deposit for the swap paid by the claimer (options premium)
     * @param claimerBounty Bounty for the claimer of the swap (used for watchtowers)
     */
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
    ): Promise<T>;

    /**
     * Checks if a given string is a valid wallet address
     *
     * @param address
     */
    isValidAddress(address: string): boolean;

    /**
     * Checks if a given string is a valid token identifier
     *
     * @param tokenIdentifier
     */
    isValidToken(tokenIdentifier: string): boolean;

    /**
     * Returns a random valid wallet address
     */
    randomAddress(): string;

    /**
     * Returns randomly generated signer
     */
    randomSigner(): Signer;

    /**
     * Returns intermediary's reputation for a given token swaps
     *
     * @param address
     * @param token
     */
    getIntermediaryReputation(address: string, token: string): Promise<IntermediaryReputationType>;

    /**
     * Returns the fee in native token base units to commit (initiate) the swap
     *
     * @param swapData Swap to initiate
     * @param feeRate Optional fee rate (fetched on-demand if not provided)
     */
    getCommitFee(swapData: T, feeRate?: string): Promise<BN>;

    /**
     * Returns the fee in native token base units to claim the swap
     *
     * @param signer Signer claiming the swap
     * @param swapData Swap to claim
     * @param feeRate Optional fee rate (fetched on-demand if not provided)
     */
    getClaimFee(signer: string, swapData: T, feeRate?: string): Promise<BN>;

    /**
     * Returns raw fee (not including any refunds we might get that would make the getClaimFee negative) for claiming the swap
     *
     * @param signer Signer claiming the swap
     * @param swapData Swap to claim
     * @param feeRate Optional fee rate (fetched on-demand if not provided)
     */
    getRawClaimFee?(signer: string, swapData: T, feeRate?: string): Promise<BN>;

    /**
     * Returns the fee in native token base units to refund the swap
     *
     * @param swapData Swap to refund
     * @param feeRate Optional fee rate (fetched on-demand if not provided)
     */
    getRefundFee(swapData: T, feeRate?: string): Promise<BN>;

    /**
     * Returns raw fee (not including any refunds we might get that would make the getRefundFee negative) for claiming the swap
     *
     * @param swapData Swap to claim
     * @param feeRate Optional fee rate (fetched on-demand if not provided)
     */
    getRawRefundFee?(swapData: T, feeRate?: string): Promise<BN>;

    /**
     * Returns the fee rate for committing (initializing) a payIn swap
     *
     * @param offerer Offerer of the swap
     * @param claimer Claimer of the swap
     * @param token Token to be swapped
     * @param paymentHash Optional payment hash
     */
    getInitPayInFeeRate(offerer: string, claimer: string, token: string, paymentHash?: string): Promise<string>;

    /**
     * Returns the fee rate for committing (initializing) a non-payIn swap
     *
     * @param offerer Offerer of the swap
     * @param claimer Claimer of the swap
     * @param token Token to be swapped
     * @param paymentHash Optional payment hash
     */
    getInitFeeRate(offerer: string, claimer: string, token: string, paymentHash?: string): Promise<string>;

    /**
     * Returns the fee rate for refunding a swap
     *
     * @param swapData Swap to refund
     */
    getRefundFeeRate(swapData: T): Promise<string>;

    /**
     * Returns the fee rate for claiming a swap as a specific signer
     *
     * @param signer Signer claiming the swap
     * @param swapData Swap to claim
     */
    getClaimFeeRate(signer: string, swapData: T): Promise<string>;

    /**
     * Compute the payment hash for a given transaction output
     *
     * @param outputScript Bitcoin output locking script
     * @param amount Amount of sats in the output
     * @param nonce Nonce to be used as replay protection
     */
    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer;

    /**
     * Returns the token address of the native currency of the chain
     */
    getNativeCurrencyAddress(): string;

    /**
     * Withdraws funds from the trading LP vault
     *
     * @param signer Signer to sign the withdrawal with
     * @param token Token to withdraw
     * @param amount Amount of the token to withdraw
     * @param txOptions Transaction options
     */
    withdraw(signer: Signer, token: string, amount: BN, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns transactions required for signer to withdraw funds from the trading LP vault
     *
     * @param signer Owner of the funds
     * @param token Token to withdraw
     * @param amount Amount of the token to withdraw
     * @param feeRate Optional fee rate to use for the transaction (fetched on-demand if not provided)
     */
    txsWithdraw(signer: string, token: string, amount: BN, feeRate?: string): Promise<TX[]>;

    /**
     * Deposits funds to the trading LP vault
     *
     * @param signer Signer to sign the deposit with
     * @param token Token to deposit
     * @param amount Amount of the token to deposit
     * @param txOptions Transaction options
     */
    deposit(signer: Signer, token: string, amount: BN, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns transactions required for signer to deposit funds to the trading LP vault
     *
     * @param signer Owner of the funds
     * @param token Token to deposit
     * @param amount Amount of the token to deposit
     * @param feeRate Optional fee rate to use for the transaction (fetched on-demand if not provided)
     */
    txsDeposit(signer: string, token: string, amount: BN, feeRate?: string): Promise<TX[]>;

    /**
     * Transfers the specific token to a given recipient
     *
     * @param signer Signer/owner of the tokens
     * @param token Token to transfer
     * @param amount Amount of token to transfer
     * @param dstAddress Destination address of the transfer
     * @param txOptions Transaction options
     */
    transfer(signer: Signer, token: string, amount: BN, dstAddress: string, txOptions?: TransactionConfirmationOptions): Promise<string>;

    /**
     * Returns transactions for transferring a specific token to a given recipient
     *
     * @param signer Signer/owner of the tokens
     * @param token Token to transfer
     * @param amount Amount of token to transfer
     * @param dstAddress Destination address of the transfer
     * @param feeRate Optional fee rate to use for the transaction (fetched on-demand if not provided)
     */
    txsTransfer(signer: string, token: string, amount: BN, dstAddress: string, feeRate?: string): Promise<TX[]>;

    /**
     * Serializes a given transaction to a string
     *
     * @param tx Transaction to serialize
     */
    serializeTx(tx: TX): Promise<string>;

    /**
     * Deserializes a transaction from string
     *
     * @param txData Serialized transaction data string
     */
    deserializeTx(txData: string): Promise<TX>;

    /**
     * Returns the status of the given serialized transaction
     *
     * @param tx Serialized transaction
     */
    getTxStatus(tx: string): Promise<"not_found" | "pending" | "success" | "reverted">;

    /**
     * Returns the status of the given transactionId (use getTxStatus whenever possible, it's more reliable)
     *
     * @param txId Transaction ID
     */
    getTxIdStatus(txId: string): Promise<"not_found" | "pending" | "success" | "reverted">;

    /**
     * Signs, sends a batch of transaction and optionally waits for their confirmation
     *
     * @param signer Signer to use for signing transactions
     * @param txs Transactions to send
     * @param waitForConfirmation Whether to wait for transaction confirmation (if parallel is not specified,
     *  every transaction's confirmation except the last one is awaited)
     * @param abortSignal Abort signal
     * @param parallel Whether to send all transactions in parallel or one by one (always waiting for the previous TX to confirm)
     * @param onBeforePublish Callback called before a tx is broadcast
     */
    sendAndConfirm(signer: Signer, txs: TX[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]>;

    /**
     * Callback called when transaction is being replaced (used for EVM, when fee is bumped on an unconfirmed tx)
     *
     * @param callback
     */
    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void;

    /**
     * Remove tx replace callback
     *
     * @param callback
     */
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean;

    /**
     * Returns the amount of deposits (in native token) that we can claim back (this is useful for SVM chains with the PDAs
     *  requiring you to put some deposit in order to store data)
     *
     * @param signer Signer to check the claimable deposits for
     */
    getClaimableDeposits?(signer: string): Promise<{count: number, totalValue: BN}>;

    /**
     * Claims the funds from claimable deposits
     *
     * @param signer Owner of the deposits, transaction signer
     * @param txOptions Transaction options
     */
    claimDeposits?(signer: Signer): Promise<{txIds: string[], count: number, totalValue: BN}>;

}
