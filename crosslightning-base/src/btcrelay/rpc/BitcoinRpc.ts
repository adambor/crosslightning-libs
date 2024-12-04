import {BtcBlock} from "../types/BtcBlock";


export type BtcVout = {
    value: number,
    n: number,
    scriptPubKey: {
        asm: string,
        hex: string
    }
};

export type BtcVin = {
    txid: string,
    vout: number,
    scriptSig: {
        asm: string,
        hex: string
    },
    sequence: number,
    txinwitness: string[]
};

export type BtcTx = {
    blockhash: string,
    confirmations: number,
    txid: string,
    hex: string

    outs: BtcVout[],
    ins: BtcVin[]
};

export type BtcBlockWithTxs = {
    height: number,
    hash: string,
    tx: BtcTx[]
};

export type BtcSyncInfo = {
    ibd: boolean,
    headers: number,
    blocks: number,
    verificationProgress: number
}

export interface BitcoinRpc<T extends BtcBlock> {

    isInMainChain(blockhash: string): Promise<boolean>;
    getBlockHeader(blockhash: string): Promise<T>;
    getMerkleProof(txId: string, blockhash: string): Promise<{
        reversedTxId: Buffer,
        pos: number,
        merkle: Buffer[],
        blockheight: number
    }>;
    getTransaction(txId: string): Promise<BtcTx>;
    getBlockhash(height: number): Promise<string>;
    getBlockWithTransactions(blockhash: string): Promise<BtcBlockWithTxs>;

    sendRawTransaction(rawTx: string): Promise<string>;
    sendRawPackage(rawTx: string[]): Promise<string[]>;

    getTipHeight(): Promise<number>;

    getSyncInfo(): Promise<BtcSyncInfo>;

}