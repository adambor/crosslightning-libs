
import {Express} from "express";
import {SwapNonce} from "./SwapNonce";
import {ISwapPrice} from "./ISwapPrice";
import {ChainEvents, StorageObject, SwapContract, SwapData, TokenAddress, IStorageManager} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    tokens: string[],
    data?: any,
};

export abstract class SwapHandler<V extends StorageObject, T extends SwapData> {

    abstract readonly type: SwapHandlerType;

    readonly storageManager: IStorageManager<V>;
    readonly path: string;

    readonly swapContract: SwapContract<T, any>;
    readonly chainEvents: ChainEvents<T>;
    readonly nonce: SwapNonce;
    readonly allowedTokens: Set<string>;
    readonly swapPricing: ISwapPrice;
    readonly LND: AuthenticatedLnd;

    protected constructor(storageDirectory: IStorageManager<V>, path: string, swapContract: SwapContract<T, any>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, allowedTokens: TokenAddress[], lnd: AuthenticatedLnd, swapPricing: ISwapPrice) {
        this.storageManager = storageDirectory;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.nonce = swapNonce;
        this.path = path;
        this.allowedTokens = new Set<string>(allowedTokens.map(e => e.toString()));
        this.LND = lnd;
        this.swapPricing = swapPricing;
    }

    abstract init(): Promise<void>;
    abstract startWatchdog(): Promise<void>;
    abstract startRestServer(restServer: Express): void;
    abstract getInfo(): SwapHandlerInfoType;

}
