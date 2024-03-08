import {BtcRelay, ChainEvents, SwapContract, SwapData} from "crosslightning-base";
import {SwapHandler} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";
import {AuthenticatedLnd} from "lightning";

export interface IPlugin<T extends SwapData> {

    name: string;
    author: string;
    description: string;

    //Needs to be called by implementation
    onEnable(
        swapContract: SwapContract<T, any, any, any>,
        btcRelay: BtcRelay<any, any, any>,
        chainEvents: ChainEvents<T>,
        lnd: AuthenticatedLnd
    ): Promise<void>;
    onDisable(): Promise<void>;

    //Called in the library
    onServiceInitialize(service: SwapHandler<any, T>): Promise<void>;

    onSwapStateChange?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapCreate?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapRemove?(swap: SwapHandlerSwap<T>): Promise<void>;

}
