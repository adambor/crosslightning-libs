import {BtcHeader} from "./BtcHeader";

export interface BtcStoredHeader<T extends BtcHeader> {

    getChainWork(): Buffer,
    getHeader(): T,
    getLastDiffAdjustment(): number,
    getBlockheight(): number,
    getPrevBlockTimestamps(): number[],
    computeNext(header: T): BtcStoredHeader<T>;

}