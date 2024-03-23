import {Response} from "cross-fetch";
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto-browserify";
import * as BN from "bn.js";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";

let url = "https://mempool.space/testnet/api/";

const BITCOIN_BLOCKTIME = 600 * 1000;
const BITCOIN_BLOCKSIZE = 1024*1024;

const timeoutPromise = (timeoutSeconds) => {
    return new Promise(resolve => {
        setTimeout(resolve, timeoutSeconds*1000)
    });
};

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

// export type BlockData = {
//     height: number,
//     hash: string,
//     timestamp: number,
//     median_timestamp: number,
//     previousblockhash: string,
//     difficulty: string,
//     header: string,
//     version: number,
//     bits: number,
//     nonce: number,
//     size: number,
//     weight: number,
//     tx_count: number,
//     merkle_root: string,
//     reward: number,
//     total_fee_amt: number,
//     avg_fee_amt: number,
//     median_fee_amt: number,
//     avg_fee_rate: number,
//     median_fee_rate: number
// };

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

let timeout: number;

export class ChainUtils {

    static async setMempoolUrl(_url: string, _timeout?: number) {
        url = _url;
        timeout = _timeout;
    }

    static async getTransaction(txId: string): Promise<BitcoinTransaction> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"tx/"+txId, {
            method: "GET",
            timeout
        }));

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
                if(resp==="Transaction not found") return null;
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async getRawTransaction(txId: string): Promise<Buffer> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"tx/"+txId+"/hex", {
            method: "GET",
            timeout
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

        let resp: string = await response.text();

        //Strip witness data
        const btcTx = bitcoin.Transaction.fromHex(resp);

        for(let txIn of btcTx.ins) {
            txIn.witness = []; //Strip witness data
        }

        return btcTx.toBuffer();

    }

    static async getAddressBalances(address: string): Promise<{
        confirmedBalance: BN,
        unconfirmedBalance: BN
    }> {
        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"address/"+address, {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        const confirmedInput = new BN(jsonBody.chain_stats.funded_txo_sum);
        const confirmedOutput = new BN(jsonBody.chain_stats.spent_txo_sum);
        const unconfirmedInput = new BN(jsonBody.mempool_stats.funded_txo_sum);
        const unconfirmedOutput = new BN(jsonBody.mempool_stats.spent_txo_sum);

        return {
            confirmedBalance: confirmedInput.sub(confirmedOutput),
            unconfirmedBalance: unconfirmedInput.sub(unconfirmedOutput)
        }
    }

    static async getAddressUTXOs(address: string): Promise<{
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
        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"address/"+address+"/utxo", {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();
        jsonBody.forEach(e => e.value = new BN(e.value));

        return jsonBody;
    }

    static async getFees(): Promise<{
        fastestFee: number,
        halfHourFee: number,
        hourFee: number,
        economyFee: number,
        minimumFee: number
    }> {
        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"v1/fees/recommended", {
            method: "GET",
            timeout
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

        return await response.json();
    }


    static async getAddressTransactions(address: string): Promise<BitcoinTransaction[]> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"address/"+address+"/txs", {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async checkAddressTxos(address: string, txoHash: Buffer): Promise<{
        tx: BitcoinTransaction,
        vout: number
    }> {

        const txs = await ChainUtils.getAddressTransactions(address);

        let found: {
            tx: BitcoinTransaction,
            vout: number
        } = null;

        for(let tx of txs) {
            for(let i=0;i<tx.vout.length;i++) {
                const vout = tx.vout[i];
                const hash = createHash("sha256").update(Buffer.concat([
                    Buffer.from(new BN(vout.value).toArray("le", 8)),
                    Buffer.from(vout.scriptpubkey, "hex")
                ])).digest();
                if(txoHash.equals(hash)) {
                    if(found==null) {
                        found = {
                            tx,
                            vout: i
                        };
                    } else {
                        if(tx.status.confirmed && !found.tx.status.confirmed) {
                            found = {
                                tx,
                                vout: i
                            }
                        }
                        if(tx.status.confirmed && found.tx.status.confirmed) {
                            if(tx.status.block_height < found.tx.status.block_height) {
                                found = {
                                    tx,
                                    vout: i
                                }
                            }
                        }
                    }
                }
            }
        }

        return found;

    }

    static async waitForAddressTxo(
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
            const result = await ChainUtils.checkAddressTxos(address, txoHash);
            if(result!=null) {
                let confirmations = 0;
                if(result.tx.status.confirmed) {
                    const tipHeight = await ChainUtils.getTipBlockHeight();
                    confirmations = tipHeight-result.tx.status.block_height+1;
                }

                let confirmationDelay = 0;
                if(confirmations===0) {
                    confirmationDelay = (await this.getTransactionConfirmationDelay(result.tx.fee/(result.tx.weight/4)));
                    if(confirmationDelay!==-1) confirmationDelay += (requiredConfirmations-1)*BITCOIN_BLOCKTIME;
                } else {
                    confirmationDelay = ((requiredConfirmations-confirmations)*BITCOIN_BLOCKTIME);
                }

                if(stateUpdateCbk!=null) stateUpdateCbk(confirmations, result.tx.txid, result.vout, confirmationDelay);

                if(confirmations>=requiredConfirmations) {
                    return result;
                }
            }
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");

    }

    static async getMempoolBlocks(): Promise<{
        blockSize: number,
        blockVSize: number,
        nTx: number,
        totalFees: number,
        medianFee: number,
        feeRange: number[]
    }[]> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"v1/fees/mempool-blocks", {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    //Returns delay in milliseconds till the transaction is expected to confirm
    static async getTransactionConfirmationDelay(feeRate: number): Promise<number> {
        const mempoolBlocks = await this.getMempoolBlocks();
        const mempoolBlockIndex = mempoolBlocks.findIndex(block => block.feeRange[0]<=feeRate);
        if(
            mempoolBlockIndex==null ||
            (
                mempoolBlockIndex+1===mempoolBlocks.length &&
                mempoolBlocks[mempoolBlocks.length-1].blockVSize>BITCOIN_BLOCKSIZE
            )
        ) return -1;
        return (mempoolBlockIndex+1) * BITCOIN_BLOCKTIME;

    }

    static transactionHasOutput(tx: BitcoinTransaction, address: string, amount: number, network: bitcoin.networks.Network) {

        const outputScript = bitcoin.address.toOutputScript(address, network);
        for(let vout of tx.vout) {
            if(Buffer.from(vout.scriptpubkey).equals(outputScript) && vout.value===amount) {
                return true;
            }
        }

        return false;

    }

    static async getTipBlockHash(): Promise<string> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"blocks/tip/hash", {
            method: "GET",
            timeout
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

        let blockHash: any = await response.text();

        return blockHash;
    }

    static async getTipBlockHeight() : Promise<number> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"blocks/tip/height", {
            method: "GET",
            timeout
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

        let respText: any = await response.text();

        const blockheight = parseInt(respText);

        return blockheight;

    }

    static async getBlock(blockhash: string): Promise<BitcoinBlockHeader> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"block/"+blockhash, {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async getBlockStatus(blockhash: string): Promise<{in_best_chain: boolean, height: number, next_best: string}> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"block/"+blockhash+"/status", {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async getTransactionProof(txId: string) : Promise<{
        block_height: number,
        merkle: string[],
        pos: number
    }> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"tx/"+txId+"/merkle-proof", {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async getBlockHash(height: number): Promise<string> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"block-height/"+height, {
            method: "GET",
            timeout
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

        let blockHash: any = await response.text();

        return blockHash;

    }

    static async getPast15Blocks(endHeight: number) : Promise<BlockData[]> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"v1/blocks/"+endHeight, {
            method: "GET",
            timeout
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

        let jsonBody: any = await response.json();

        jsonBody.forEach(e => {
            e.hash = e.id;
        });

        return jsonBody;

    }

    static async sendTransaction(transactionHex: string): Promise<string> {
        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"tx", {
            method: "POST",
            timeout,
            body: transactionHex
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

        return await response.text();
    }

}
