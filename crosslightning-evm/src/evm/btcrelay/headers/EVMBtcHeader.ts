import {BtcHeader} from "crosslightning-base"
import {BigNumber} from "ethers";
import {reverseBigNumber} from "./EVMBtcStoredHeader";

type EVMBtcHeaderType = {
    version: number,
    reversedPrevBlockhash: Buffer,
    merkleRoot: Buffer,
    timestamp: number,
    nbits: number,
    nonce: number,
    hash?: Buffer
}

type EVMBtcHeaderStruct = {
    version: BigNumber,
    reversedPrevBlockHash: string,
    merkleRoot: string,
    timestamp: BigNumber,
    nbits: BigNumber,
    nonce: BigNumber
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

    serializeToStruct(): EVMBtcHeaderStruct {
        return {
            version: reverseBigNumber(BigNumber.from(this.version)),
            reversedPrevBlockHash: "0x"+this.reversedPrevBlockhash.toString("hex"),
            merkleRoot: "0x"+this.merkleRoot.toString("hex"),
            timestamp: reverseBigNumber(BigNumber.from(this.timestamp)),
            nbits: reverseBigNumber(BigNumber.from(this.nbits)),
            nonce: reverseBigNumber(BigNumber.from(this.nonce))
        }
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