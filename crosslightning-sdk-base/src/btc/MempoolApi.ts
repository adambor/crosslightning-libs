import {Transaction} from "bitcoinjs-lib";
import createHash from "create-hash";
import * as BN from "bn.js";
import {fetchWithTimeout, timeoutPromise, tryWithRetries} from "../utils/RetryUtils";
import {Buffer} from "buffer";

type TxVout = {
    scriptpubkey: string,
    scriptpubkey_asm: string,
    scriptpubkey_type: string,
    scriptpubkey_address: string,
    value: number
};

type TxVin = {
    txid: string,
    vout: number,
    prevout: TxVout,
    scriptsig: string,
    scriptsig_asm: string,
    witness: string[],
    is_coinbase: boolean,
    sequence: number,
    inner_witnessscript_asm: string
};

export type BitcoinTransaction = {
    txid: string,
    version: number,
    locktime: number,
    vin: TxVin[],
    vout: TxVout[],
    size: number,
    weight: number,
    fee: number,
    status: {
        confirmed: boolean,
        block_height: number,
        block_hash: string,
        block_time: number
    }
};

export type BlockData = {
    bits: number,
    difficulty: number,
    extras: any,
    height: number,
    id: string,
    mediantime: number,
    merkle_root: string,
    nonce: number,
    previousblockhash: string,
    size: number,
    timestamp: number,
    tx_count: number,
    version: number,
    weight: number
}

export type BitcoinBlockHeader = {
    id: string,
    height: number,
    version: number,
    timestamp: number,
    tx_count: number,
    size: number,
    weight: number,
    merkle_root: string,
    previousblockhash: string,
    mediantime: number,
    nonce: number,
    bits: number,
    difficulty: number
};

export type LNNodeInfo = {
    public_key: string,
    alias: string,
    first_seen: number,
    updated_at: number,
    color: string,
    sockets: string,
    as_number: number,
    city_id: number,
    country_id: number,
    subdivision_id: number,
    longtitude: number,
    latitude: number,
    iso_code: string,
    as_organization: string,
    city: {[lang: string]: string},
    country: {[lang: string]: string},
    subdivision: {[lang: string]: string},
    active_channel_count: number,
    capacity: string,
    opened_channel_count: number,
    closed_channel_count: number
};

export type AddressInfo = {
    address: string;
    chain_stats: {
        funded_txo_count: number;
        funded_txo_sum: number;
        spent_txo_count: number;
        spent_txo_sum: number;
        tx_count: number;
    };
    mempool_stats: {
        funded_txo_count: number;
        funded_txo_sum: number;
        spent_txo_count: number;
        spent_txo_sum: number;
        tx_count: number;
    };
};

export type TransactionCPFPData = {
    ancestors: {
        txid: string,
        fee: number,
        weight: number
    }[],
    descendants: {
        txid: string,
        fee: number,
        weight: number
    }[],
    effectiveFeePerVsize: number,
    sigops: number,
    adjustedVsize: number
};

export type BitcoinFees = {
    fastestFee: number,
    halfHourFee: number,
    hourFee: number,
    economyFee: number,
    minimumFee: number
};

export type BitcoinPendingBlock = {
    blockSize: number,
    blockVSize: number,
    nTx: number,
    totalFees: number,
    medianFee: number,
    feeRange: number[]
};

export type BlockStatus = {
    in_best_chain: boolean,
    height: number,
    next_best: string
};

export type TransactionProof = {
    block_height: number,
    merkle: string[],
    pos: number
};

const BITCOIN_BLOCKTIME = 600 * 1000;
const BITCOIN_BLOCKSIZE = 1024*1024;

export class MempoolApi {

    url: string;
    timeout: number;

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
        ])).digest()
    }

    /**
     * Returns delay in milliseconds till an unconfirmed transaction is expected to confirm, returns -1
     *  if the transaction won't confirm any time soon
     *
     * @param feeRate
     * @private
     */
    private async getTimeTillConfirmation(feeRate: number): Promise<number> {
        const mempoolBlocks = await this.getPendingBlocks();
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
     * Returns current confirmation count for a transaction & estimates after which time it will be confirmed with the
     *  required amount of confirmations, confirmationDelay of -1 means the transaction won't confirm in the near future
     *
     * @param tx
     * @param requiredConfirmations
     * @private
     */
    private async getConfirmationDelay(tx: BitcoinTransaction, requiredConfirmations: number): Promise<{
        confirmations: number,
        confirmationDelay: number
    } | null> {
        let confirmations: number = 0;
        let confirmationDelay: number = 0;
        if(tx.status.confirmed) {
            const tipHeight = await this.getTipBlockHeight();
            confirmations = tipHeight-tx.status.block_height+1;
            if(confirmations<requiredConfirmations) confirmationDelay = ((requiredConfirmations-confirmations)*BITCOIN_BLOCKTIME);
        } else {
            //Get CPFP data
            const cpfpData = await this.getCPFPData(tx.txid);
            if(cpfpData.effectiveFeePerVsize==null) {
                //Transaction is either confirmed in the meantime, or replaced
                return null;
            }
            confirmationDelay = (await this.getTimeTillConfirmation(cpfpData.effectiveFeePerVsize));
            if(confirmationDelay!==-1) confirmationDelay += (requiredConfirmations-1)*BITCOIN_BLOCKTIME;
        }
        return {
            confirmations,
            confirmationDelay
        }
    }

    /**
     * Sends a GET or POST request to the mempool api, handling the non-200 responses as errors & throwing
     *
     * @param path
     * @param responseType
     * @param type
     * @param body
     */
    async request<T>(
        path: string,
        responseType: T extends string ? "str" : "obj",
        type: "GET" | "POST" = "GET",
        body?: string | any
    ) : Promise<T> {
        const response: Response = await tryWithRetries(() => fetchWithTimeout(this.url+path, {
            method: type,
            timeout: this.timeout,
            body: typeof(body)==="string" ? body : JSON.stringify(body)
        }));

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        if(responseType==="str") return await response.text() as any;
        return await response.json();
    }

    constructor(url?: string, timeout?: number) {
        this.url = url || "https://mempool.space/testnet/api/";
        this.timeout = timeout;
    }

    /**
     * Returns information about a specific lightning network node as identified by the public key (in hex encoding)
     *
     * @param pubkey
     */
    getLNNodeInfo(pubkey: string): Promise<LNNodeInfo | null> {
        return this.request<LNNodeInfo>("v1/lightning/nodes/"+pubkey, "obj").catch((e: Error) => {
            if(e.message==="This node does not exist, or our node is not seeing it yet") return null;
            throw e;
        });
    }

    /**
     * Returns on-chain transaction as identified by its txId
     *
     * @param txId
     */
    getTransaction(txId: string): Promise<BitcoinTransaction | null> {
        return this.request<BitcoinTransaction>("tx/"+txId, "obj").catch((e: Error) => {
            if(e.message==="Transaction not found") return null;
            throw e;
        });
    }

    /**
     * Returns raw binary encoded bitcoin transaction, also strips the witness data from the transaction
     *
     * @param txId
     * @param stripWitness (defaults to true) strips the witness data from the transaction
     */
    async getRawTransaction(txId: string, stripWitness: boolean = true): Promise<Buffer> {
        const rawTransaction: string = await this.request<string>("tx/"+txId+"/hex", "str");

        //Strip witness data
        const btcTx = Transaction.fromHex(rawTransaction);
        if(stripWitness) btcTx.ins.forEach(txIn => txIn.witness = []);
        return btcTx.toBuffer();
    }

    /**
     * Returns confirmed & unconfirmed balance of the specific bitcoin address
     *
     * @param address
     */
    async getAddressBalances(address: string): Promise<{
        confirmedBalance: BN,
        unconfirmedBalance: BN
    }> {
        const jsonBody = await this.request<AddressInfo>("address/"+address, "obj");

        const confirmedInput = new BN(jsonBody.chain_stats.funded_txo_sum);
        const confirmedOutput = new BN(jsonBody.chain_stats.spent_txo_sum);
        const unconfirmedInput = new BN(jsonBody.mempool_stats.funded_txo_sum);
        const unconfirmedOutput = new BN(jsonBody.mempool_stats.spent_txo_sum);

        return {
            confirmedBalance: confirmedInput.sub(confirmedOutput),
            unconfirmedBalance: unconfirmedInput.sub(unconfirmedOutput)
        }
    }

    /**
     * Returns CPFP (children pays for parent) data for a given transaction
     *
     * @param txId
     */
    getCPFPData(txId: string): Promise<TransactionCPFPData> {
        return this.request<TransactionCPFPData>("v1/cpfp/"+txId, "obj");
    }

    /**
     * Returns UTXOs (unspent transaction outputs) for a given address
     *
     * @param address
     */
    async getAddressUTXOs(address: string): Promise<{
        txid: string,
        vout: number,
        status: {
            confirmed: boolean,
            block_height: number,
            block_hash: string,
            block_time: number
        },
        value: BN
    }[]> {
        let jsonBody: any = await this.request<any>("address/"+address+"/utxo", "obj");
        jsonBody.forEach(e => e.value = new BN(e.value));

        return jsonBody;
    }

    /**
     * Returns current on-chain bitcoin fees
     */
    getFees(): Promise<BitcoinFees> {
        return this.request<BitcoinFees>("v1/fees/recommended", "obj");
    }

    /**
     * Returns all transactions for a given address
     *
     * @param address
     */
    getAddressTransactions(address: string): Promise<BitcoinTransaction[]> {
        return this.request<BitcoinTransaction[]>("address/"+address+"/txs", "obj");
    }

    /**
     * Checks if an address received the transaction with the required txoHash, returns info about that
     *  specific transaction if found, or null if not found
     *
     * @param address
     * @param txoHash
     */
    async checkAddressTxos(address: string, txoHash: Buffer): Promise<{
        tx: BitcoinTransaction,
        vout: number
    } | null> {
        const allTxs = await this.getAddressTransactions(address);

        const relevantTxs = allTxs
            .map(tx => {
                return {
                    tx,
                    vout: tx.vout.findIndex(vout => MempoolApi.getTxoHash(vout).equals(txoHash))
                }
            })
            .filter(obj => obj.vout>=0)
            .sort((a, b) => {
                if(a.tx.status.confirmed && !b.tx.status.confirmed) return -1;
                if(!a.tx.status.confirmed && b.tx.status.confirmed) return 1;
                if(a.tx.status.confirmed && b.tx.status.confirmed) return a.tx.status.block_height-b.tx.status.block_height;
                return 0;
            });

        return relevantTxs.length>0 ? relevantTxs[0] : null;
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
        tx: BitcoinTransaction,
        vout: number
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new Error("Aborted");
        }

        while(abortSignal==null || !abortSignal.aborted) {
            const result = await this.checkAddressTxos(address, txoHash);
            if(result==null) continue;

            const confirmationData = await this.getConfirmationDelay(result.tx, requiredConfirmations);
            if(confirmationData==null) continue;

            if(stateUpdateCbk!=null) stateUpdateCbk(
                confirmationData.confirmations,
                result.tx.txid,
                result.vout,
                confirmationData.confirmationDelay
            );

            if(confirmationData.confirmationDelay===0) return result;

            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");
    }

    /**
     * Returns expected pending (mempool) blocks
     */
    getPendingBlocks(): Promise<BitcoinPendingBlock[]> {
        return this.request<BitcoinPendingBlock[]>("v1/fees/mempool-blocks", "obj");
    }

    /**
     * Returns the blockheight of the current bitcoin blockchain's tip
     */
    async getTipBlockHeight() : Promise<number> {
        const response: string = await this.request<string>("blocks/tip/height", "str");
        return parseInt(response);
    }

    /**
     * Returns the bitcoin blockheader as identified by its blockhash
     *
     * @param blockhash
     */
    getBlockHeader(blockhash: string): Promise<BitcoinBlockHeader> {
        return this.request<BitcoinBlockHeader>("block/"+blockhash, "obj");
    }

    /**
     * Returns the block status
     *
     * @param blockhash
     */
    getBlockStatus(blockhash: string): Promise<BlockStatus> {
        return this.request<BlockStatus>("block/"+blockhash+"/status", "obj");
    }

    /**
     * Returns the transaction's proof (merkle proof)
     *
     * @param txId
     */
    getTransactionProof(txId: string) : Promise<TransactionProof> {
        return this.request<TransactionProof>("tx/"+txId+"/merkle-proof", "obj");
    }

    /**
     * Returns blockhash of a block at a specific blockheight
     *
     * @param height
     */
    getBlockHash(height: number): Promise<string> {
        return this.request<string>("block-height/"+height, "str");
    }

    /**
     * Returns past 15 blockheaders before (and including) the specified height
     *
     * @param endHeight
     */
    getPast15BlockHeaders(endHeight: number) : Promise<BlockData[]> {
        return this.request<BlockData[]>("v1/blocks/"+endHeight, "obj");
    }

    /**
     * Sends raw hex encoded bitcoin transaction
     *
     * @param transactionHex
     */
    sendTransaction(transactionHex: string): Promise<string> {
        return this.request<string>("tx", "str", "POST", transactionHex);
    }

}
