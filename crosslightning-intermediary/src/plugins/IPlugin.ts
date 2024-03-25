import {BtcRelay, ChainEvents, SwapContract, SwapData} from "crosslightning-base";
import {FromBtcLnRequestType, FromBtcRequestType, SwapHandler, ToBtcLnRequestType, ToBtcRequestType} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";
import {AuthenticatedLnd} from "lightning";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import * as BN from "bn.js";

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

    onHttpServerStarted?(expressServer: any): Promise<void>;

    onSwapStateChange?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapCreate?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapRemove?(swap: SwapHandlerSwap<T>): Promise<void>;

    onSwapRequestToBtcLn?(req: Request & {paramReader: IParamReader}, requestData: ToBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}>;
    onSwapRequestToBtc?(req: Request & {paramReader: IParamReader}, requestData: ToBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}>;
    onSwapRequestFromBtcLn?(req: Request & {paramReader: IParamReader}, requestData: FromBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}>;
    onSwapRequestFromBtc?(req: Request & {paramReader: IParamReader}, requestData: FromBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}>;

    /**
     * Returns whitelisted bitcoin txIds that are OK to spend even with 0-confs
     */
    getWhitelistedTxIds?(): string[];

}
