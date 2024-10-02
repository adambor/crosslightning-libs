import {ChainSwapType} from "crosslightning-base";

export class SwapTypeEnum {

    static toChainSwapType(data: any): number {
        const text = Object.keys(data)[0];
        if(text==="htlc") return ChainSwapType.HTLC;
        if(text==="chain") return ChainSwapType.CHAIN;
        if(text==="chainNonced") return ChainSwapType.CHAIN_NONCED;
        if(text==="chainTxhash") return ChainSwapType.CHAIN_TXID;
        return null;
    }

    static toNumber(data: any): number {
        const text = Object.keys(data)[0];
        if(text==="htlc") return 0;
        if(text==="chain") return 1;
        if(text==="chainNonced") return 2;
        if(text==="chainTxhash") return 3;
        return null;
    }

    static fromNumber(kind: 0 | 1 | 2 | 3): {htlc?: never; chain?: never; chainNonced?: never;} & {chainTxhash: Record<string,never>} {
        if(kind===0) return {htlc: null} as any;
        if(kind===1) return {chain: null} as any;
        if(kind===2) return {chainNonced: null} as any;
        if(kind===3) return {chainTxhash: null} as any;
    }

};