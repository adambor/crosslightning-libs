import {Transaction} from "bitcoinjs-lib";
import * as BN from "bn.js";
import {Buffer} from "buffer";
import {fetchWithTimeout, tryWithRetries} from "../../utils/Utils";
import {RequestError} from "../../errors/RequestError";

export type TxVout = {
    scriptpubkey: string,
    scriptpubkey_asm: string,
    scriptpubkey_type: string,
    scriptpubkey_address: string,
    value: number
};

export type TxVin = {
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

export class MempoolApi {

    url: string;
    timeout: number;

    /**
     * Sends a GET or POST request to the mempool api, handling the non-200 responses as errors & throwing
     *
     * @param path
     * @param responseType
     * @param type
     * @param body
     */
    private async request<T>(
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
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
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
