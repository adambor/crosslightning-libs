import {BtcStoredHeader} from "./types/BtcStoredHeader";
import {BtcBlock} from "./types/BtcBlock";
import * as BN from "bn.js";

export interface BtcRelay<V extends BtcStoredHeader<any>, T, B extends BtcBlock> {

    maxHeadersPerTx: number;
    maxForkHeadersPerTx: number;
    maxShortForkHeadersPerTx?: number;

    getTipData(): Promise<{
        blockheight: number,
        commitHash: string,
        chainWork: Buffer
    }>;

    retrieveLogAndBlockheight(blockData: {blockhash: string, height: number}, requiredBlockheight?: number): Promise<{
        header: V,
        height: number
    }>;
    retrieveLogByCommitHash(commitHash: string, blockData: {blockhash: string, height: number}): Promise<V>;

    retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: V,
        resultBitcoinHeader: B
    }>;
    //retrieveOnchainTip(): Promise<B>;

    saveInitialHeader(header: B, epochStart: number, pastBlocksTimestamps: number[], feeRate?: string): Promise<T>;
    saveMainHeaders(mainHeaders: B[], storedHeader: V, feeRate?: string): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;
    saveNewForkHeaders(forkHeaders: B[], storedHeader: V, tipWork: Buffer, feeRate?: string): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;
    saveForkHeaders(forkHeaders: B[], storedHeader: V, forkId: number, tipWork: Buffer, feeRate?: string): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;
    saveShortForkHeaders?(forkHeaders: B[], storedHeader: V, tipWork: Buffer, feeRate?: string): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;

    getMainFeeRate?(): Promise<string>;
    getForkFeeRate?(forkId: number): Promise<string>;

    estimateSynchronizeFee(requiredBlockheight: number, feeRate?: string): Promise<BN>;

    getFeePerBlock(feeRate?: any): Promise<BN>;

    sweepForkData?(lastSweepTimestamp?: number): Promise<number | null>;

}