import {BtcStoredHeader} from "./types/BtcStoredHeader";
import {BtcBlock} from "./types/BtcBlock";

export interface BtcRelay<V extends BtcStoredHeader<any>, T, B extends BtcBlock> {

    maxHeadersPerTx: number;
    maxForkHeadersPerTx: number;

    getTipData(): Promise<{
        commitHash: string,
        blockhash: string,
        chainWork: Buffer
    }>;

    retrieveLogAndBlockheight(blockhash: string, requiredBlockheight?: number): Promise<{
        header: V,
        height: number
    }>;
    retrieveLogByCommitHash(commitHash: string, blockHash: string): Promise<V>;

    retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: V,
        resultBitcoinHeader: B
    }>;
    retrieveOnchainTip(): Promise<B>;


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