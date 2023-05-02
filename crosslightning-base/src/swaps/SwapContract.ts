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
    init(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    claimWithSecret(swapData: T, secret: string, checkExpiry?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    claimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    refund(swapData: T, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    refundWithAuthorization(swapData: T, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string>;
    initAndClaimWithSecret(swapData: T, timeout: string, prefix: string, signature: string, nonce: number, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string[]>;

    txsClaimWithSecret(swapData: T, secret: string): Promise<TX[]>;
    txsClaimWithTxData(swapData: T, blockheight: number, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number, storedHeader?: BtcStoredHeader<any>, synchronizer?: RelaySynchronizer<any, TX, any>, initAta?: boolean): Promise<TX[]>;
    txsRefund(swapData: T): Promise<TX[]>;

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

    getInitSignature(swapData: T, nonce: ISwapNonce, authorizationTimeout: number): Promise<{
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }>;
    isValidInitAuthorization(swapData: T, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer | null>;

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
        payOut: boolean
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

}
