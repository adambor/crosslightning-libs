import {BTCMerkleTree} from "./BTCMerkleTree";
import {BitcoinRpc, BtcBlockWithTxs, BtcSyncInfo, BtcTx, BtcVin, BtcVout} from "crosslightning-base";
import * as bitcoin from "bitcoinjs-lib";
import {AuthenticatedLnd, authenticatedLndGrpc} from "lightning";
import * as lncli from "ln-service";
import * as apiForProto from "lightning/lnd_grpc/api_for_proto";
import * as grpcCredentials from "lightning/lnd_grpc/grpc_credentials";
import { join } from "path";
import {NeutrinoBlock, NeutrinoBlockType} from "./NeutrinoBlock";
import {max} from "bn.js";

export type BitcoindVout = {
    value: number,
    n: number,
    scriptPubKey: {
        asm: string,
        hex: string,
        reqSigs: number,
        type: string,
        addresses: string[]
    }
};

export type BitcoindVin = {
    txid: string,
    vout: number,
    scriptSig: {
        asm: string,
        hex: string
    },
    sequence: number,
    txinwitness: string[]
};

export type BitcoindTransaction = {
    hex: string,
    txid: string,
    hash: string,
    size: number,
    vsize: number,
    weight: number,
    version: number,
    locktime: number,
    vin: BitcoindVin[],
    vout: BitcoindVout[],
    blockhash: string,
    confirmations: number,
    blocktime: number,
    time: number
};

type BitcoindRawBlock = {
    hash: string,
    confirmations: number,
    size: number,
    strippedsize: number,
    weight: number,
    height: number,
    version: number,
    versionHex: string,
    merkleroot: string,
    tx: BitcoindTransaction[],
    time: number,
    mediantime: number,
    nonce: number,
    bits: string,
    difficulty: number,
    nTx: number,
    previousblockhash: string,
    nextblockhash: string
}

type BitcoindBlockchainInfo = {
    chain : string,
    blocks : number,
    headers : number,
    bestblockhash : string,
    difficulty : number,
    time : number,
    mediantime : number,
    verificationprogress : number,
    initialblockdownload : boolean,
    chainwork : string,
    size_on_disk : number,
    pruned : boolean,
    pruneheight : number,
    automatic_pruning : boolean,
    prune_target_size : number,
    warnings : string
}

function toBtcTx(btcTx: bitcoin.Transaction, blockId: string, confirmations: number): BtcTx {
    const txIns: BtcVin[] = [];
    const txOuts: BtcVout[] = [];

    for(let txIn of btcTx.ins) {
        txIns.push({
            txid: txIn.hash.toString("hex"),
            vout: txIn.index,
            scriptSig: {
                asm: bitcoin.script.toASM(txIn.script),
                hex: txIn.script.toString("hex")
            },
            sequence: txIn.sequence,
            txinwitness: txIn.witness.map(e => e.toString("hex"))
        });
        txIn.witness = []; //Strip witness data
    }

    btcTx.outs.forEach((txOut, index) => {
        txOuts.push({
            value: txOut.value,
            n: index,
            scriptPubKey: {
                asm: bitcoin.script.toASM(txOut.script),
                hex: txOut.script.toString("hex")
            }
        });
    })

    const resultHex = btcTx.toHex();

    return {
        blockhash: blockId,
        confirmations: confirmations,
        txid: btcTx.getId(),
        hex: resultHex,
        outs: txOuts,
        ins: txIns
    }
}

export class NeutrinoRpc implements BitcoinRpc<NeutrinoBlock> {

    lnd: AuthenticatedLnd & {neutrino?: any};
    maxStoredBlocks: number;

    blockCache: {
        [blockId: string]: NeutrinoBlockType
    };

    constructor(
        socket: string,
        macaroon: string,
        cert: string,
        maxStoredBlocks: number = 20
    ) {
        const {lnd} = authenticatedLndGrpc({socket, macaroon, cert});
        this.lnd = lnd;
        const {credentials} = grpcCredentials({cert, macaroon});

        this.lnd.neutrino = apiForProto({
            path: join(__dirname, "../../../protos/neutrino.proto"),
            credentials,
            socket,
            params: {
                'grpc.max_receive_message_length': -1,
                'grpc.max_send_message_length': -1,
            },
            service: "NeutrinoKit",
            type: "neutrinorpc"
        });

        this.maxStoredBlocks = maxStoredBlocks;
    }

    async getTipHeight(): Promise<number> {
        const resp = await lncli.getWalletInfo({lnd: this.lnd});
        return resp.current_block_height;
    }

    private getNeutrinoBlock(blockhash: string): Promise<NeutrinoBlockType> {
        const block = this.blockCache[blockhash];
        if(block!=null) {
            return Promise.resolve(block);
        } else {
            return new Promise((resolve, reject) => {
                this.lnd.neutrino.getBlock({
                    hash: blockhash
                }, (err, res: NeutrinoBlockType) => {
                    if (!!err) {
                        return reject([503, 'UnexpectedErrorWhenGettingBlockHeader', {err}]);
                    }
                    if (!res) {
                        return reject([503, 'ExpectedResponseForChainBlockHeaderRequest']);
                    }
                    const keys = Object.keys(this.blockCache);
                    if(keys.length>=this.maxStoredBlocks) {
                        delete this.blockCache[keys[0]];
                    }
                    this.blockCache[blockhash] = res;
                    resolve(res);
                });
            });
        }
    }

    async getBlockHeader(blockhash: string): Promise<NeutrinoBlock> {
        return new NeutrinoBlock(await this.getNeutrinoBlock(blockhash));
    }

    async isInMainChain(blockhash: string): Promise<boolean> {
        const header = await lncli.getBlockHeader({
            lnd: this.lnd,
            id: blockhash
        }).catch(e => {
            if(Array.isArray(e)) {
                if(e[0]===503 && e[1]==="UnexpectedErrorWhenGettingBlockHeader" && e[2]?.err?.code===2) {
                    return null;
                }
            }
            throw e;
        });
        return header==null;
    }

    async getMerkleProof(txId: string, blockhash: string): Promise<{
        reversedTxId: Buffer,
        pos: number,
        merkle: Buffer[],
        blockheight: number
    }> {
        return BTCMerkleTree.getTransactionMerkle(txId, await this.getBlockWithTransactions(blockhash));
    }

    async getTransaction(txId: string): Promise<BtcTx> {

        const resp = await lncli.getChainTransactions({
            lnd: this.lnd
        });

        const tx = resp.transactions.find(tx => tx.id===txId);

        if(tx==null) return null;

        const btcTx = bitcoin.Transaction.fromHex(tx.transaction);

        return toBtcTx(btcTx, tx.block_id, tx.confirmation_count);

    }

    async getBlockhash(height: number): Promise<string> {
        const resp = await lncli.getBlockHeader({
            lnd: this.lnd,
            height
        });
        const block = bitcoin.Block.fromHex(resp.header);
        return block.getId();
    }

    async getBlockWithTransactions(blockhash: string): Promise<BtcBlockWithTxs> {
        const resp: NeutrinoBlockType = await this.getNeutrinoBlock(blockhash);
        const block = bitcoin.Block.fromHex(resp.raw_hex);
        const blockId = block.getId();
        return {
            height: resp.height,
            hash: resp.hash,
            tx: block.transactions.map((tx, index) => toBtcTx(tx, blockId, resp.confirmations))
        };
    }

    async getSyncInfo(): Promise<BtcSyncInfo> {
        const walletInfo = await lncli.getWalletInfo();

        return {
            ibd: walletInfo.is_synced_to_chain,
            verificationProgress: walletInfo.is_synced_to_chain ? 1 : 0,
            headers: walletInfo.current_block_height,
            blocks: walletInfo.current_block_height,
            _: walletInfo
        } as any;
    }

}