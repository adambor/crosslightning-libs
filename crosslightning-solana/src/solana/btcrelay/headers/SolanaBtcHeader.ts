import {BtcHeader} from "crosslightning-base";

type SolanaBtcHeaderType = {
    version: number,
    reversedPrevBlockhash: number[],
    merkleRoot: number[],
    timestamp: number,
    nbits: number,
    nonce: number,
    hash?: Buffer
}

export class SolanaBtcHeader implements BtcHeader {

    version: number;
    reversedPrevBlockhash: number[];
    merkleRoot: number[];
    timestamp: number;
    nbits: number;
    nonce: number;
    hash?: Buffer;

    constructor(obj: SolanaBtcHeaderType) {
        this.version = obj.version;
        this.reversedPrevBlockhash = obj.reversedPrevBlockhash;
        this.merkleRoot = obj.merkleRoot;
        this.timestamp = obj.timestamp;
        this.nbits = obj.nbits;
        this.nonce = obj.nonce;
        this.hash = obj.hash;
    }

    getMerkleRoot(): Buffer {
        return Buffer.from(this.merkleRoot);
    }

    getNbits(): number {
        return this.nbits;
    }

    getNonce(): number {
        return this.nonce;
    }

    getReversedPrevBlockhash(): Buffer {
        return Buffer.from(this.reversedPrevBlockhash);
    }

    getTimestamp(): number {
        return this.timestamp;
    }

    getVersion(): number {
        return this.version;
    }

}