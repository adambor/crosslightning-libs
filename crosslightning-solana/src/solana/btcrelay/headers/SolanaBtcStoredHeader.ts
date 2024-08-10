import {BtcStoredHeader, StatePredictorUtils} from "crosslightning-base";
import {SolanaBtcHeader} from "./SolanaBtcHeader";

type SolanaBtcStoredHeaderType = {
    chainWork: number[],
    header: SolanaBtcHeader,
    lastDiffAdjustment: number,
    blockheight: number,
    prevBlockTimestamps: number[]
}

export class SolanaBtcStoredHeader implements BtcStoredHeader<SolanaBtcHeader> {

    chainWork: number[];
    header: SolanaBtcHeader;
    lastDiffAdjustment: number;
    blockheight: number;
    prevBlockTimestamps: number[];

    constructor(obj: SolanaBtcStoredHeaderType) {
        this.chainWork = obj.chainWork;
        this.header = obj.header;
        this.lastDiffAdjustment = obj.lastDiffAdjustment;
        this.blockheight = obj.blockheight;
        this.prevBlockTimestamps = obj.prevBlockTimestamps;
    }

    getBlockheight(): number {
        return this.blockheight;
    }

    getChainWork(): Buffer {
        return Buffer.from(this.chainWork);
    }

    getHeader(): SolanaBtcHeader {
        return this.header;
    }

    getLastDiffAdjustment(): number {
        return this.lastDiffAdjustment;
    }

    getPrevBlockTimestamps(): number[] {
        return this.prevBlockTimestamps;
    }

    private computeNextBlockTimestamps(): number[] {
        const prevBlockTimestamps = [...this.prevBlockTimestamps];
        for(let i=1;i<10;i++) {
            prevBlockTimestamps[i-1] = prevBlockTimestamps[i];
        }
        prevBlockTimestamps[9] = this.header.timestamp;
        return prevBlockTimestamps;
    }

    private computeNextChainWork(nbits: number): number[] {
        const chainWork = [...this.chainWork];
        StatePredictorUtils.addInPlace(chainWork, [...StatePredictorUtils.getDifficulty(nbits)]);
        return chainWork;
    }

    private computeNextLastDiffAdjustment(headerTimestamp: number) {
        const blockheight = this.blockheight+1;

        let lastDiffAdjustment = this.lastDiffAdjustment;
        if(blockheight % StatePredictorUtils.DIFF_ADJUSTMENT_PERIOD === 0) {
            lastDiffAdjustment = headerTimestamp;
        }

        return lastDiffAdjustment;
    }

    computeNext(header: SolanaBtcHeader): SolanaBtcStoredHeader {
        return new SolanaBtcStoredHeader({
            chainWork: this.computeNextChainWork(header.nbits),
            prevBlockTimestamps: this.computeNextBlockTimestamps(),
            blockheight: this.blockheight+1,
            lastDiffAdjustment: this.computeNextLastDiffAdjustment(header.timestamp),
            header
        });
    }

}