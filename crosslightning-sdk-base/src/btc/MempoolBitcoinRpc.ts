import {BitcoinRpc, BtcBlockWithTxs, BtcTx} from "crosslightning-base";
import {MempoolBitcoinBlock} from "./MempoolBitcoinBlock";
import {ChainUtils} from "./ChainUtils";


export class MempoolBitcoinRpc implements BitcoinRpc<MempoolBitcoinBlock> {

    getTipHeight(): Promise<number> {
        return ChainUtils.getTipBlockHeight();
    }

    async getBlockHeader(blockhash: string): Promise<MempoolBitcoinBlock> {
        return new MempoolBitcoinBlock(await ChainUtils.getBlock(blockhash));
    }

    async getMerkleProof(txId: string, blockhash: string): Promise<{ reversedTxId: Buffer; pos: number; merkle: Buffer[]; blockheight: number }> {
        const proof = await ChainUtils.getTransactionProof(txId);
        return {
            reversedTxId: Buffer.from(txId, "hex").reverse(),
            pos: proof.pos,
            merkle: proof.merkle.map(e => Buffer.from(e, "hex").reverse()),
            blockheight: proof.block_height
        };
    }

    async getTransaction(txId: string): Promise<BtcTx> {
        const tx = await ChainUtils.getTransaction(txId);
        const rawTx = await ChainUtils.getRawTransaction(txId);

        let confirmations: number;
        if(tx.status!=null && tx.status.confirmed) {
            const blockheight = await ChainUtils.getTipBlockHeight();
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
        const blockStatus = await ChainUtils.getBlockStatus(blockhash);
        return blockStatus.in_best_chain;
    }

    getBlockhash(height: number): Promise<string> {
        return ChainUtils.getBlockHash(height);
    }

    getBlockWithTransactions(blockhash: string): Promise<BtcBlockWithTxs> {
        throw new Error("Unsupported.");
    }

}