import {BitcoinRpc, BtcBlockWithTxs, BtcSyncInfo, BtcTx} from "crosslightning-base";
import {MempoolBitcoinBlock} from "./MempoolBitcoinBlock";
import {MempoolApi} from "./MempoolApi";
import {Buffer} from "buffer";

export class MempoolBitcoinRpc implements BitcoinRpc<MempoolBitcoinBlock> {

    api: MempoolApi;

    constructor(mempoolApi: MempoolApi) {
        this.api = mempoolApi;
    }

    getTipHeight(): Promise<number> {
        return this.api.getTipBlockHeight();
    }

    async getBlockHeader(blockhash: string): Promise<MempoolBitcoinBlock> {
        return new MempoolBitcoinBlock(await this.api.getBlockHeader(blockhash));
    }

    async getMerkleProof(txId: string, blockhash: string): Promise<{
        reversedTxId: Buffer;
        pos: number;
        merkle: Buffer[];
        blockheight: number
    }> {
        const proof = await this.api.getTransactionProof(txId);
        return {
            reversedTxId: Buffer.from(txId, "hex").reverse(),
            pos: proof.pos,
            merkle: proof.merkle.map(e => Buffer.from(e, "hex").reverse()),
            blockheight: proof.block_height
        };
    }

    async getTransaction(txId: string): Promise<BtcTx> {
        const tx = await this.api.getTransaction(txId);
        const rawTx = await this.api.getRawTransaction(txId);

        let confirmations: number = 0;
        if(tx.status!=null && tx.status.confirmed) {
            const blockheight = await this.api.getTipBlockHeight();
            confirmations = blockheight-tx.status.block_height+1;
        }

        return {
            blockhash: tx.status?.block_hash,
            confirmations,
            txid: tx.txid,
            hex: rawTx.toString("hex"),
            outs: tx.vout.map((e, index) => {
                return {
                    value: e.value,
                    n: index,
                    scriptPubKey: {
                        hex: e.scriptpubkey,
                        asm: e.scriptpubkey_asm
                    }
                }
            }),
            ins: tx.vin.map(e => {
                return {
                    txid: e.txid,
                    vout: e.vout,
                    scriptSig: {
                        hex: e.scriptsig,
                        asm: e.scriptsig_asm
                    },
                    sequence: e.sequence,
                    txinwitness: e.witness
                }
            }),
        };
    }

    async isInMainChain(blockhash: string): Promise<boolean> {
        const blockStatus = await this.api.getBlockStatus(blockhash);
        return blockStatus.in_best_chain;
    }

    getBlockhash(height: number): Promise<string> {
        return this.api.getBlockHash(height);
    }

    getBlockWithTransactions(blockhash: string): Promise<BtcBlockWithTxs> {
        throw new Error("Unsupported.");
    }

    async getSyncInfo(): Promise<BtcSyncInfo> {
        const tipHeight = await this.api.getTipBlockHeight();
        return {
            verificationProgress: 1,
            blocks: tipHeight,
            headers: tipHeight,
            ibd: false
        };
    }

    async getPast15Blocks(height: number): Promise<MempoolBitcoinBlock[]> {
        return (await this.api.getPast15BlockHeaders(height)).map(blockHeader => new MempoolBitcoinBlock(blockHeader));
    }

}