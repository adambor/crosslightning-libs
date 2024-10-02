import {BtcRelay, BtcStoredHeader, RelaySynchronizer} from "crosslightning-base/dist";
import {MempoolBitcoinBlock} from "../MempoolBitcoinBlock";
import {MempoolBitcoinRpc} from "../MempoolBitcoinRpc";

import {getLogger, timeoutPromise} from "../../../utils/Utils";

const logger = getLogger("MempoolBtcRelaySynchronizer: ")

export class MempoolBtcRelaySynchronizer<B extends BtcStoredHeader<any>, TX> implements RelaySynchronizer<B, TX, MempoolBitcoinBlock > {

    bitcoinRpc: MempoolBitcoinRpc;
    btcRelay: BtcRelay<B, TX, MempoolBitcoinBlock>;

    constructor(btcRelay: BtcRelay<B, TX, MempoolBitcoinBlock>, bitcoinRpc: MempoolBitcoinRpc) {
        this.btcRelay = btcRelay;
        this.bitcoinRpc = bitcoinRpc;
    }

    async syncToLatestTxs(): Promise<{
        txs: TX[]
        targetCommitedHeader: B,
        computedHeaderMap: {[blockheight: number]: B},
        blockHeaderMap: {[blockheight: number]: MempoolBitcoinBlock},
        btcRelayTipBlockHash: string,
        latestBlockHeader: MempoolBitcoinBlock,
        startForkId: number
    }> {
        const tipData = await this.btcRelay.getTipData();

        let cacheData: {
            forkId: number,
            lastStoredHeader: B,
            tx: TX,
            computedCommitedHeaders: B[]
        } = {
            forkId: 0,
            lastStoredHeader: null,
            tx: null,
            computedCommitedHeaders: null
        };

        const {resultStoredHeader, resultBitcoinHeader} = await this.btcRelay.retrieveLatestKnownBlockLog();
        cacheData.lastStoredHeader = resultStoredHeader;
        if(resultStoredHeader.getBlockheight()<tipData.blockheight) cacheData.forkId = -1; //Indicate that we will be submitting blocks to fork

        let spvTipBlockHeader = resultBitcoinHeader;
        const btcRelayTipBlockHash = spvTipBlockHeader.getHash();

        logger.debug("Retrieved stored header with commitment: ", cacheData.lastStoredHeader);
        logger.debug("SPV tip bitcoin RPC block header: ", spvTipBlockHeader);

        let spvTipBlockHeight = spvTipBlockHeader.height;

        const txsList: TX[] = [];
        const blockHeaderMap: {[blockheight: number]: MempoolBitcoinBlock} = {
            [resultBitcoinHeader.getHeight()]: resultBitcoinHeader
        };
        const computedHeaderMap: {[blockheight: number]: B} = {
            [resultStoredHeader.getBlockheight()]: resultStoredHeader
        };
        let startForkId = null;

        let forkFee: string;
        let mainFee: string;
        const saveHeaders = async (headerCache: MempoolBitcoinBlock[]) => {
            if(cacheData.forkId===-1) {
                if(mainFee==null) mainFee = await this.btcRelay.getMainFeeRate();
                cacheData = await this.btcRelay.saveNewForkHeaders(headerCache, cacheData.lastStoredHeader, tipData.chainWork, mainFee);
            } else if(cacheData.forkId===0) {
                if(mainFee==null) mainFee = await this.btcRelay.getMainFeeRate();
                cacheData = await this.btcRelay.saveMainHeaders(headerCache, cacheData.lastStoredHeader, mainFee);
            } else {
                if(forkFee==null) forkFee = await this.btcRelay.getForkFeeRate(cacheData.forkId);
                cacheData = await this.btcRelay.saveForkHeaders(headerCache, cacheData.lastStoredHeader, cacheData.forkId, tipData.chainWork, forkFee)
            }
            if(cacheData.forkId!==-1 && cacheData.forkId!==0) startForkId = cacheData.forkId;
            txsList.push(cacheData.tx);
            for(let storedHeader of cacheData.computedCommitedHeaders) {
                computedHeaderMap[storedHeader.getBlockheight()] = storedHeader;
            }
        };

        let retrievedHeaders: MempoolBitcoinBlock[] = null;
        let headerCache: MempoolBitcoinBlock[] = [];

        while(retrievedHeaders==null || retrievedHeaders.length>0) {
            retrievedHeaders = await this.bitcoinRpc.getPast15Blocks(spvTipBlockHeight+15);

            for(let i=retrievedHeaders.length-1;i>=0;i--) {
                const header = retrievedHeaders[i];

                blockHeaderMap[header.height] = header;
                headerCache.push(header);

                if(cacheData.forkId===0 ?
                    headerCache.length>=this.btcRelay.maxHeadersPerTx :
                    headerCache.length>=this.btcRelay.maxForkHeadersPerTx) {

                    await saveHeaders(headerCache);
                    headerCache = [];
                }
            }

            if(retrievedHeaders.length>0) {
                spvTipBlockHeight = retrievedHeaders[0].height;
                await timeoutPromise(1000);
            }
        }

        if(headerCache.length>0) await saveHeaders(headerCache);

        return {
            txs: txsList,
            targetCommitedHeader: cacheData.lastStoredHeader,

            blockHeaderMap,
            computedHeaderMap,

            btcRelayTipBlockHash: btcRelayTipBlockHash,
            latestBlockHeader: spvTipBlockHeader,
            startForkId
        };
    }

}
