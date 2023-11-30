import fetch, {Response} from "cross-fetch";
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto-browserify";
import * as BN from "bn.js";
import {timeoutSignal, tryWithRetries} from "../utils/RetryUtils";

let url = "https://mempool.space/testnet/api/";

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

        const response: Response = await tryWithRetries(() => fetch(url+"tx/"+txId, {
            method: "GET",
            signal: timeoutSignal(timeout)
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

    static async getRawTransaction(txId: string): Promise<Buffer> {

        const response: Response = await tryWithRetries(() => fetch(url+"tx/"+txId+"/hex", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

    static async getAddressTransactions(address: string): Promise<BitcoinTransaction[]> {

        const response: Response = await tryWithRetries(() => fetch(url+"address/"+address+"/txs", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

    static async waitForAddressTxo(address: string, txoHash: Buffer, requiredConfirmations: number, stateUpdateCbk:(confirmations: number, txId: string, vout: number) => void, abortSignal?: AbortSignal, intervalSeconds?: number): Promise<{
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

                if(stateUpdateCbk!=null) stateUpdateCbk(confirmations, result.tx.txid, result.vout);

                if(confirmations>=requiredConfirmations) {
                    return result;
                }
            }
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");

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

        const response: Response = await tryWithRetries(() => fetch(url+"blocks/tip/hash", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"blocks/tip/height", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"block/"+blockhash, {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"block/"+blockhash+"/status", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"tx/"+txId+"/merkle-proof", {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"block-height/"+height, {
            method: "GET",
            signal: timeoutSignal(timeout)
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

        const response: Response = await tryWithRetries(() => fetch(url+"v1/blocks/"+endHeight, {
            method: "GET",
            signal: timeoutSignal(timeout)
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

}
