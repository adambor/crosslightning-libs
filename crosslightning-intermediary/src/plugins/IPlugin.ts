import {BtcRelay, ChainEvents, RelaySynchronizer, SwapContract, SwapData} from "crosslightning-base";
import {SwapHandler} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";

export interface IPlugin<T extends SwapData> {

    name: string;
    author: string;
    description: string;

    //Needs to be called by implementation
    onEnable(
        swapContract: SwapContract<T, any>,
        btcRelay: BtcRelay<any, any, any>,
        btcRelaySynchronizer: RelaySynchronizer<any, any, any>,
        chainEvents: ChainEvents<T>
    ): Promise<void>;
    onDisable(): Promise<void>;

    //Called in the library
    onServiceInitialize(service: SwapHandler<any, T>): Promise<void>;
    onSwapStateChange(swap: SwapHandlerSwap<T>): Promise<void>;

}
