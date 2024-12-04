import {BtcBlockWithTxs, BtcSyncInfo, BtcTx} from "crosslightning-base";
import {MempoolBitcoinBlock} from "./MempoolBitcoinBlock";
import {BitcoinTransaction, MempoolApi, TxVout} from "./MempoolApi";
import {Buffer} from "buffer";
import * as createHash from "create-hash";
import * as BN from "bn.js";
import {BitcoinRpcWithTxoListener, BtcTxWithBlockheight} from "../BitcoinRpcWithTxoListener";
import {LightningNetworkApi, LNNodeLiquidity} from "../LightningNetworkApi";
import {timeoutPromise} from "../../utils/Utils";

const BITCOIN_BLOCKTIME = 600 * 1000;
const BITCOIN_BLOCKSIZE = 1024*1024;

export class MempoolBitcoinRpc implements BitcoinRpcWithTxoListener<MempoolBitcoinBlock>, LightningNetworkApi {

    api: MempoolApi;

    constructor(mempoolApi: MempoolApi) {
        this.api = mempoolApi;
    }

    /**
     * Returns a txo hash for a specific transaction vout
     *
     * @param vout
     * @private
     */
    private static getTxoHash(vout: TxVout): Buffer {
        return createHash("sha256").update(Buffer.concat([
            Buffer.from(new BN(vout.value).toArray("le", 8)),
            Buffer.from(vout.scriptpubkey, "hex")
        ])).digest();
    }

    /**
     * Returns delay in milliseconds till an unconfirmed transaction is expected to confirm, returns -1
     *  if the transaction won't confirm any time soon
     *
     * @param feeRate
     * @private
     */
    private async getTimeTillConfirmation(feeRate: number): Promise<number> {
        const mempoolBlocks = await this.api.getPendingBlocks();
        const mempoolBlockIndex = mempoolBlocks.findIndex(block => block.feeRange[0]<=feeRate);
        if(mempoolBlockIndex===-1) return -1;
        //Last returned block is usually an aggregate (or a stack) of multiple btc blocks, if tx falls in this block
        // and the last returned block really is an aggregate one (size bigger than BITCOIN_BLOCKSIZE) we return -1
        if(
            mempoolBlockIndex+1===mempoolBlocks.length &&
            mempoolBlocks[mempoolBlocks.length-1].blockVSize>BITCOIN_BLOCKSIZE
        ) return -1;
        return (mempoolBlockIndex+1) * BITCOIN_BLOCKTIME;
    }

    /**
     * Returns an estimate after which time the tx will confirm with the required amount of confirmations,
     *  confirmationDelay of -1 means the transaction won't confirm in the near future
     *
     * @param tx
     * @param requiredConfirmations
     * @private
     *
     * @returns estimated confirmation delay, -1 if the transaction won't confirm in the near future, null if the
     *  transaction was replaced or was confirmed in the meantime
     */
    private async getConfirmationDelay(tx: BtcTx, requiredConfirmations: number): Promise<number | null> {
        if(tx.confirmations>requiredConfirmations) return 0;
        if(tx.confirmations===0) {
            //Get CPFP data
            const cpfpData = await this.api.getCPFPData(tx.txid);
            if(cpfpData.effectiveFeePerVsize==null) {
                //Transaction is either confirmed in the meantime, or replaced
                return null;
            }
            let confirmationDelay = (await this.getTimeTillConfirmation(cpfpData.effectiveFeePerVsize));
            if(confirmationDelay!==-1) confirmationDelay += (requiredConfirmations-1)*BITCOIN_BLOCKTIME;
            return confirmationDelay;
        }
        return ((requiredConfirmations-tx.confirmations)*BITCOIN_BLOCKTIME);
    }

    /**
     * Converts mempool API's transaction to BtcTx object
     * @param tx Transaction to convert
     * @param getRaw If the raw transaction field should be filled (requires one more network request)
     * @private
     */
    private async toBtcTx(tx: BitcoinTransaction, getRaw: boolean = true): Promise<BtcTxWithBlockheight> {
        const rawTx: Buffer = !getRaw ? null : await this.api.getRawTransaction(tx.txid);

        let confirmations: number = 0;
        if(tx.status!=null && tx.status.confirmed) {
            const blockheight = await this.api.getTipBlockHeight();
            confirmations = blockheight-tx.status.block_height+1;
        }

        return {
            blockheight: tx.status?.block_height,
            blockhash: tx.status?.block_hash,
            confirmations,
            txid: tx.txid,
            hex: rawTx==null ? null : rawTx.toString("hex"),
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

    async getTransaction(txId: string): Promise<BtcTxWithBlockheight> {
        const tx = await this.api.getTransaction(txId);
        if(tx==null) return null;
        return await this.toBtcTx(tx);
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

    async checkAddressTxos(address: string, txoHash: Buffer): Promise<{
        tx: BtcTxWithBlockheight,
        vout: number
    } | null> {
        const allTxs = await this.api.getAddressTransactions(address);

        const relevantTxs = allTxs
            .map(tx => {
                return {
                    tx,
                    vout: tx.vout.findIndex(vout => MempoolBitcoinRpc.getTxoHash(vout).equals(txoHash))
                }
            })
            .filter(obj => obj.vout>=0)
            .sort((a, b) => {
                if(a.tx.status.confirmed && !b.tx.status.confirmed) return -1;
                if(!a.tx.status.confirmed && b.tx.status.confirmed) return 1;
                if(a.tx.status.confirmed && b.tx.status.confirmed) return a.tx.status.block_height-b.tx.status.block_height;
                return 0;
            });

        if(relevantTxs.length===0) return null;

        return {
            tx: await this.toBtcTx(relevantTxs[0].tx, false),
            vout: relevantTxs[0].vout
        };
    }

    /**
     * Waits till the address receives a transaction containing a specific txoHash
     *
     * @param address
     * @param txoHash
     * @param requiredConfirmations
     * @param stateUpdateCbk
     * @param abortSignal
     * @param intervalSeconds
     */
    async waitForAddressTxo(
        address: string,
        txoHash: Buffer,
        requiredConfirmations: number,
        stateUpdateCbk:(confirmations: number, txId: string, vout: number, txEtaMS: number) => void,
        abortSignal?: AbortSignal,
        intervalSeconds?: number
    ): Promise<{
        tx: BtcTxWithBlockheight,
        vout: number
    }> {
        if(abortSignal!=null) abortSignal.throwIfAborted();

        while(abortSignal==null || !abortSignal.aborted) {
            await timeoutPromise((intervalSeconds || 5)*1000, abortSignal);

            const result = await this.checkAddressTxos(address, txoHash);
            if(result==null) {
                stateUpdateCbk(null, null, null, null);
                continue;
            }

            const confirmationDelay = await this.getConfirmationDelay(result.tx, requiredConfirmations);
            if(confirmationDelay==null) continue;

            if(stateUpdateCbk!=null) stateUpdateCbk(
                result.tx.confirmations,
                result.tx.txid,
                result.vout,
                confirmationDelay
            );

            if(confirmationDelay===0) return result;
        }

        abortSignal.throwIfAborted();
    }

    async getLNNodeLiquidity(pubkey: string): Promise<LNNodeLiquidity> {
        const nodeInfo = await this.api.getLNNodeInfo(pubkey);
        return {
            publicKey: nodeInfo.public_key,
            capacity: new BN(nodeInfo.capacity),
            numChannels: nodeInfo.active_channel_count
        }
    }

    sendRawTransaction(rawTx: string): Promise<string> {
        return this.api.sendTransaction(rawTx);
    }

    sendRawPackage(rawTx: string[]): Promise<string[]> {
        throw new Error("Unsupported");
    }

}