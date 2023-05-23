import {EVMBtcHeader} from "./EVMBtcHeader";
import {BtcStoredHeader} from "crosslightning-base";
import {BigNumber} from "ethers";
import {StatePredictorUtils} from "crosslightning-base/dist";

type EVMBtcStoredHeaderType = {
    chainWork: BigNumber,
    reversedPrevBlockHash: string,
    merkleRoot: string,
    data1: BigNumber,
    data2: BigNumber
}

function reverseBigNumber(num: BigNumber): BigNumber {
    const buffer = Buffer.alloc(4);
    buffer.writeUint32LE(num.toNumber());
    return BigNumber.from("0x"+buffer.toString("hex"));
}

export class EVMBtcStoredHeader implements BtcStoredHeader<EVMBtcHeader> {

    chainWork: BigNumber;
    reversedPrevBlockHash: string;
    merkleRoot: string;
    data1: BigNumber;
    data2: BigNumber;

    constructor(obj: EVMBtcStoredHeaderType) {
        this.chainWork = obj.chainWork;
        this.reversedPrevBlockHash = obj.reversedPrevBlockHash;
        this.merkleRoot = obj.merkleRoot;
        this.data1 = obj.data1;
        this.data2 = obj.data2;
    }

    getChainWork(): Buffer {
        return Buffer.from(this.chainWork.toHexString().substring(2).padStart(64, "0"), "hex");
    }

    getHeader(): EVMBtcHeader {
        const version = reverseBigNumber(this.data1.shr(224).and(BigNumber.from(0xFFFFFFFF)));
        const nbits = reverseBigNumber(this.data1.shr(192).and(BigNumber.from(0xFFFFFFFF)));
        const nonce = reverseBigNumber(this.data1.shr(160).and(BigNumber.from(0xFFFFFFFF)));
        const timestamp = this.data2.and(BigNumber.from(0xFFFFFFFF));
        return new EVMBtcHeader({
            version: version.toNumber(),
            reversedPrevBlockhash: Buffer.from(this.reversedPrevBlockHash.substring(2), "hex"),
            merkleRoot: Buffer.from(this.merkleRoot.substring(2), "hex"),
            timestamp: timestamp.toNumber(),
            nbits: nbits.toNumber(),
            nonce: nonce.toNumber()
        });
    }

    getLastDiffAdjustment(): number {
        return this.data1.shr(128).and(BigNumber.from(0xFFFFFFFF)).toNumber();
    }

    getBlockheight(): number {
        return this.data1.shr(96).and(BigNumber.from(0xFFFFFFFF)).toNumber();
    }

    getPrevBlockTimestamps(): number[] {
        const arr: number[] = [];
        for(let i=64;i>=0;i-=32) {
            arr.push(this.data1.shr(i).and(BigNumber.from(0xFFFFFFFF)).toNumber());
        }
        for(let i=224;i>=32;i-=32) {
            arr.push(this.data2.shr(i).and(BigNumber.from(0xFFFFFFFF)).toNumber());
        }
        return arr;
    }

    computeNext(header: EVMBtcHeader): EVMBtcStoredHeader {

        //console.log("[EVMBtcStoredHeader] Compute next with header: ", header);

        const blockheight = this.getBlockheight()+1;

        const prevBlockTimestamps = this.getPrevBlockTimestamps();
        //console.log("[EVMBtcStoredHeader: computeNext] Timestamps: ", prevBlockTimestamps);

        for(let i=1;i<10;i++) {
            prevBlockTimestamps[i-1] = prevBlockTimestamps[i];
        }

        const currentHeader = this.getHeader();
        //console.log("[EVMBtcStoredHeader: computeNext] Current header: ", header);

        prevBlockTimestamps[9] = currentHeader.getTimestamp();

        let lastDiffAdjustment = this.getLastDiffAdjustment();
        if(blockheight % StatePredictorUtils.DIFF_ADJUSTMENT_PERIOD === 0) {
            lastDiffAdjustment = header.timestamp;
        }

        //console.log("[EVMBtcStoredHeader: computeNext] Computing difficulty...");

        const difficulty = StatePredictorUtils.getDifficulty(header.nbits);

        const diffNum = BigNumber.from("0x"+difficulty.toString("hex"));

        //console.log("[EVMBtcStoredHeader: computeNext] Difficulty computed: ", diffNum.toHexString());

        const data1: BigNumber = reverseBigNumber(BigNumber.from(header.version)).and(BigNumber.from("0xFFFFFFFF")).shl(224)
            .or(reverseBigNumber(BigNumber.from(header.nbits)).and(BigNumber.from("0xFFFFFFFF")).shl(192))
            .or(reverseBigNumber(BigNumber.from(header.nonce)).and(BigNumber.from("0xFFFFFFFF")).shl(160))
            .or(BigNumber.from(lastDiffAdjustment).and(BigNumber.from("0xFFFFFFFF")).shl(128))
            .or(BigNumber.from(blockheight).and(BigNumber.from("0xFFFFFFFF")).shl(96))
            .or(BigNumber.from(prevBlockTimestamps[0]).and(BigNumber.from("0xFFFFFFFF")).shl(64))
            .or(BigNumber.from(prevBlockTimestamps[1]).and(BigNumber.from("0xFFFFFFFF")).shl(32))
            .or(BigNumber.from(prevBlockTimestamps[2]).and(BigNumber.from("0xFFFFFFFF")));

        let data2: BigNumber = BigNumber.from(0);

        for(let i=0;i<7;i++) {
            data2 = data2.or(BigNumber.from(prevBlockTimestamps[3+i]).and("0xFFFFFFFF").shl((7-i)*32))
        }
        data2 = data2.or(BigNumber.from(header.timestamp).and("0xFFFFFFFF"));

        return new EVMBtcStoredHeader({
            chainWork: this.chainWork.add(diffNum),
            reversedPrevBlockHash: "0x"+header.reversedPrevBlockhash.toString("hex"),
            merkleRoot: "0x"+header.merkleRoot.toString("hex"),
            data1,
            data2
        });

    }

}
