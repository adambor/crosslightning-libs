import {BtcStoredHeader} from "../types/BtcStoredHeader";
import {BtcBlock} from "../types/BtcBlock";


export interface RelaySynchronizer<V extends BtcStoredHeader<any>, T, B extends BtcBlock> {

    syncToLatestTxs(signer: string): Promise<{
        txs: T[]
        targetCommitedHeader: V,
        computedHeaderMap: {[blockheight: number]: V},
        blockHeaderMap: {[blockheight: number]: B},
        btcRelayTipBlockHash: string,
        latestBlockHeader: B,
        startForkId?: number
    }>;

}