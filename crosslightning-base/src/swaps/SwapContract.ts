import {SwapData} from "./SwapData";
import {TokenAddress} from "./TokenAddress";
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

export interface SwapContract<T extends SwapData, TX, PreFetchData, PreFetchVerification> {

    claimWithSecretTimeout: number;
    claimWithTxDataTimeout: number;
    refundTimeout: number;

    start(): Promise<void>;

    initPayIn(swapData: T, timeout: string, prefix: string, signature: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsInitPayIn(swapData: T, timeout: string, prefix: string, signature: string, skipChecks?: boolean, feeRate?: any): Promise<TX[]>;

    init(swapData: T, timeout: string, prefix: string, signature: string, txoHash?: Buffer, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsInit(swapData: T, timeout: string, prefix: string, signature: string, txoHash?: Buffer, skipChecks?: boolean, feeRate?: any): Promise<TX[]>;

    claimWithSecret(swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsClaimWithSecret(swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: any): Promise<TX[]>;

    claimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsClaimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, feeRate?: any): Promise<TX[]>;

    refund(swapData: T, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsRefund(swapData: T, check?: boolean, initAta?: boolean, feeRate?: any): Promise<TX[]>;

    refundWithAuthorization(swapData: T, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string>;
    txsRefundWithAuthorization(swapData: T, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, feeRate?: any): Promise<TX[]>;

    initAndClaimWithSecret(swapData: T, timeout: string, prefix: string, signature: string, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: any): Promise<string[]>;

    isExpired(swapData: T): boolean;
    isClaimable(swapData: T): Promise<boolean>;
    isCommited(swapData: T): Promise<boolean>;
    getCommitStatus(swapData: T): Promise<SwapCommitStatus>;
    getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus>;

    getCommitedData(paymentHash: string): Promise<T>;

    isRequestRefundable(swapData: T): Promise<boolean>;

    preFetchBlockDataForSignatures?(): Promise<PreFetchData>;
    preFetchForInitSignatureVerification?(data: PreFetchData): Promise<PreFetchVerification>;

    getClaimInitSignature(swapData: T, authorizationTimeout: number, preFetchedBlockData?: PreFetchData, feeRate?: any): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidClaimInitAuthorization(swapData: T, timeout: string, prefix: string, signature: string, feeRate?: any, preFetchedVerificationData?: PreFetchVerification): Promise<Buffer | null>;
    getClaimInitAuthorizationExpiry(swapData: T, timeout: string, prefix: string, signature: string, preFetchedVerificationData?: PreFetchVerification): Promise<number>;
    isClaimInitAuthorizationExpired(swapData: T, timeout: string, prefix: string, signature: string): Promise<boolean>;

    getInitSignature(swapData: T, authorizationTimeout: number, preFetchedBlockData?: PreFetchData, feeRate?: any): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidInitAuthorization(swapData: T, timeout: string, prefix: string, signature: string, feeRate?: any, preFetchedVerificationData?: PreFetchVerification): Promise<Buffer | null>;
    getInitAuthorizationExpiry(swapData: T, timeout: string, prefix: string, signature: string, preFetchedVerificationData?: PreFetchVerification): Promise<number>;
    isInitAuthorizationExpired(swapData: T, timeout: string, prefix: string, signature: string): Promise<boolean>;

    getRefundSignature(swapData: T, authorizationTimeout: number): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidRefundAuthorization(swapData: T, timeout: string, prefix: string, signature: string): Promise<Buffer | null>;

    getDataSignature(data: Buffer): Promise<string>;
    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean>;

    getBalance(token: TokenAddress, inContract: boolean): Promise<BN>;

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
    ): Promise<T>;

    areWeClaimer(swapData: T): boolean;
    areWeOfferer(swapData: T): boolean;

    getAddress(): string;
    isValidAddress(address: string): boolean;

    getIntermediaryReputation(address: string, token?: TokenAddress): Promise<IntermediaryReputationType>;
    getIntermediaryBalance(address: string, token?: TokenAddress): Promise<BN>;
    toTokenAddress(address: string): TokenAddress;

    getCommitFee(swapData: T, feeRate?: any): Promise<BN>;
    getClaimFee(swapData: T, feeRate?: any): Promise<BN>;
    getRefundFee(swapData: T, feeRate?: any): Promise<BN>;

    getInitPayInFeeRate?(offerer: string, claimer: string, token: TokenAddress, paymentHash?: string): Promise<any>;
    getInitFeeRate?(offerer: string, claimer: string, token: TokenAddress, paymentHash?: string): Promise<any>;
    getRefundFeeRate?(swapData: T): Promise<any>;
    getClaimFeeRate?(swapData: T): Promise<any>;

    setUsAsClaimer(swapData: T);
    setUsAsOfferer(swapData: T);

    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer;

    getNativeCurrencyAddress(): TokenAddress;

    withdraw(token: TokenAddress, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsWithdraw(token: TokenAddress, amount: BN): Promise<TX[]>;
    deposit(token: TokenAddress, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsDeposit(token: TokenAddress, amount: BN): Promise<TX[]>;

    transfer(token: TokenAddress, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsTransfer(token: TokenAddress, amount: BN, dstAddress: string): Promise<TX[]>;

    //getTxId(tx: TX): Promise<string>;

    serializeTx(tx: TX): Promise<string>;
    deserializeTx(txData: string): Promise<TX>;

    getTxStatus(tx: string): Promise<"not_found" | "pending" | "success" | "reverted">;
    getTxIdStatus(txId: string): Promise<"not_found" | "pending" | "success" | "reverted">;

    sendAndConfirm(txs: TX[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]>;

    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void;
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean;

}
