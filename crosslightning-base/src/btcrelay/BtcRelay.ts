import {BtcStoredHeader} from "./types/BtcStoredHeader";
import {BtcBlock} from "./types/BtcBlock";

export interface BtcRelay<V extends BtcStoredHeader<any>, T, B extends BtcBlock> {

    maxHeadersPerTx: number;
    maxForkHeadersPerTx: number;

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


    saveMainHeaders(mainHeaders: B[], storedHeader: V): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;
    saveNewForkHeaders(forkHeaders: B[], storedHeader: V, tipWork: Buffer): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;
    saveForkHeaders(forkHeaders: B[], storedHeader: V, forkId: number, tipWork: Buffer): Promise<{
        forkId: number,
        lastStoredHeader: V,
        tx: T,
        computedCommitedHeaders: V[]
    }>;

}