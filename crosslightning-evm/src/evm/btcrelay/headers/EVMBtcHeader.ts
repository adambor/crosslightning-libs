import {BtcHeader} from "crosslightning-base"

type EVMBtcHeaderType = {
    version: number,
    reversedPrevBlockhash: Buffer,
    merkleRoot: Buffer,
    timestamp: number,
    nbits: number,
    nonce: number,
    hash?: Buffer
}

export class EVMBtcHeader implements BtcHeader {

    version: number;
    reversedPrevBlockhash: Buffer;
    merkleRoot: Buffer;
    timestamp: number;
    nbits: number;
    nonce: number;
    hash?: Buffer;

    constructor(obj: EVMBtcHeaderType) {
        this.version = obj.version;
        this.reversedPrevBlockhash = obj.reversedPrevBlockhash;
        this.merkleRoot = obj.merkleRoot;
        this.timestamp = obj.timestamp;
        this.nbits = obj.nbits;
        this.nonce = obj.nonce;
        this.hash = obj.hash;
    }

    serialize(): Buffer {
        const versionBuffer = Buffer.alloc(4);
        versionBuffer.writeUint32LE(this.version);
        const restBuffer = Buffer.alloc(12);
        restBuffer.writeUint32LE(this.timestamp, 0);
        restBuffer.writeUint32LE(this.nbits, 4);
        restBuffer.writeUint32LE(this.nonce, 8);

        return Buffer.concat([
            versionBuffer,
            this.reversedPrevBlockhash,
            this.merkleRoot,
            restBuffer
        ]);
    }

    getMerkleRoot(): Buffer {
        return this.merkleRoot;
    }

    getNbits(): number {
        return this.nbits;
    }

    getNonce(): number {
        return this.nonce;
    }

    getReversedPrevBlockhash(): Buffer {
        return this.reversedPrevBlockhash;
    }

    getTimestamp(): number {
        return this.timestamp;
    }

    getVersion(): number {
        return this.version;
    }

}