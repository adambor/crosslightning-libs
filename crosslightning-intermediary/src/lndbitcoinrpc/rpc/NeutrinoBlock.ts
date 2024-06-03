import {BtcBlock} from "crosslightning-base";

export type NeutrinoBlockType = {
    hash: string,
    confirmations: number,
    stripped_size: number,
    size: number,
    weight: number,
    height: number,
    version: number,
    version_hex: string,
    merkleroot: string,
    time: number,
    nonce: number,
    bits: string,
    ntx: number,
    previous_block_hash: string,
    raw_hex: string
}

export class NeutrinoBlock implements BtcBlock {

    hash: string;
    confirmations: number;
    stripped_size: number;
    size: number;
    weight: number;
    height: number;
    version: number;
    version_hex: string;
    merkleroot: string;
    time: number;
    nonce: number;
    bits: string;
    ntx: number;
    previous_block_hash: string;

    constructor(obj: NeutrinoBlockType) {
        this.hash = obj.hash;
        this.confirmations = obj.confirmations;
        this.stripped_size = obj.stripped_size;
        this.size = obj.size;
        this.weight = obj.weight;
        this.height = obj.height;
        this.version = obj.version;
        this.version_hex = obj.version_hex;
        this.merkleroot = obj.merkleroot;
        this.time = obj.time;
        this.nonce = obj.nonce;
        this.bits = obj.bits;
        this.ntx = obj.ntx;
        this.previous_block_hash = obj.previous_block_hash;
    }

    getHeight(): number {
        return this.height;
    }

    getHash(): string {
        return this.hash;
    }

    getMerkleRoot(): string {
        return this.merkleroot;
    }

    getNbits(): number {
        return Buffer.from(this.bits, "hex").readUint32BE();
    }

    getNonce(): number {
        return this.nonce;
    }

    getPrevBlockhash(): string {
        return this.previous_block_hash;
    }

    getTimestamp(): number {
        return this.time;
    }

    getVersion(): number {
        return this.version;
    }

    getChainWork(): Buffer {
        throw new Error("Unsupported!");
    }

}