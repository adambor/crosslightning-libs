import {SwapData} from "./SwapData";
import {TokenAddress} from "./TokenAddress";
import * as BN from "bn.js";
import {ISwapNonce} from "./ISwapNonce";
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

export interface SwapContract<T extends SwapData, TX> {

    claimWithSecretTimeout: number;
    claimWithTxDataTimeout: number;
    refundTimeout: number;

    start(): Promise<void>;

    initPayIn(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsInitPayIn(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<TX[]>;
    init(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsInit(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<TX[]>;
    claimWithSecret(swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsClaimWithSecret(swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean): Promise<TX[]>;
    claimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsClaimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean): Promise<TX[]>;
    refund(swapData: T, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsRefund(swapData: T, check?: boolean, initAta?: boolean): Promise<TX[]>;
    refundWithAuthorization(swapData: T, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    txsRefundWithAuthorization(swapData: T, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean): Promise<TX[]>;
    initAndClaimWithSecret(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string[]>;

    isExpired(swapData: T): boolean;
    isClaimable(swapData: T): Promise<boolean>;
    isCommited(swapData: T): Promise<boolean>;
    getCommitStatus(swapData: T): Promise<SwapCommitStatus>;
    getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus>;

    getCommitedData(paymentHash: string): Promise<T>;

    isRequestRefundable(swapData: T): Promise<boolean>;

    getClaimInitSignature(swapData: T, nonce: ISwapNonce, authorizationTimeout: number): Promise<{
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidClaimInitAuthorization(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer | null>;
    getClaimInitAuthorizationExpiry(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<number>;
    isClaimInitAuthorizationExpired(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<boolean>;

    getInitSignature(swapData: T, nonce: ISwapNonce, authorizationTimeout: number): Promise<{
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidInitAuthorization(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer | null>;
    getInitAuthorizationExpiry(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<number>;
    isInitAuthorizationExpired(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<boolean>;

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

    getCommitFee(): Promise<BN>;
    getClaimFee(): Promise<BN>;
    getRefundFee(): Promise<BN>;

    setUsAsClaimer(swapData: T);
    setUsAsOfferer(swapData: T);

    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer;

    getNativeCurrencyAddress(): TokenAddress;

    withdraw(token: TokenAddress, amount: BN): Promise<boolean>;
    deposit(token: TokenAddress, amount: BN): Promise<boolean>;

    transfer(token: TokenAddress, amount: BN, dstAddress: string): Promise<boolean>;

}
