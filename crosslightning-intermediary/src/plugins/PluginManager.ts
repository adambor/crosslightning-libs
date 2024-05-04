import {BitcoinRpc, BtcRelay, ChainEvents, SwapContract, SwapData, TokenAddress} from "crosslightning-base";
import {IPlugin} from "./IPlugin";
import {
    FromBtcLnRequestType,
    FromBtcRequestType,
    ISwapPrice,
    SwapHandler,
    ToBtcLnRequestType,
    ToBtcRequestType
} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";
import {AuthenticatedLnd} from "lightning";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import * as BN from "bn.js";
import * as fs from "fs";
import {Command, createCommand} from "crosslightning-server-base";


export class PluginManager {

    static plugins: Map<string, IPlugin<any>> = new Map();

    static registerPlugin(name: string, plugin: IPlugin<any>) {
        PluginManager.plugins.set(name, plugin);
    }

    static unregisterPlugin(name: string): boolean {
        return PluginManager.plugins.delete(name);
    }

    static async enable<T extends SwapData>(
        swapContract: SwapContract<T, any, any, any>,
        btcRelay: BtcRelay<any, any, any>,
        chainEvents: ChainEvents<T>,

        bitcoinRpc: BitcoinRpc<any>,
        lnd: AuthenticatedLnd,

        swapPricing: ISwapPrice,
        tokens: {
            [ticker: string]: {address: TokenAddress, decimals: number}
        },

        directory: string
    ): Promise<void> {
        try {
            fs.mkdirSync(directory);
        } catch (e) {}
        for(let [name, plugin] of PluginManager.plugins.entries()) {
            try {
                try {
                    fs.mkdirSync(directory+"/"+name);
                } catch (e) {}
                await plugin.onEnable(
                    swapContract,
                    btcRelay,
                    chainEvents,
                    bitcoinRpc,
                    lnd,
                    swapPricing,
                    tokens,
                    directory+"/"+name
                );
            } catch (e) {
                console.error("Plugin ENABLE error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async disable() {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                await plugin.onDisable();
            } catch (e) {
                console.error("Plugin DISABLE error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async serviceInitialize<T extends SwapData>(handler: SwapHandler<any, T>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                await plugin.onServiceInitialize(handler);
            } catch (e) {
                console.error("Plugin onServiceInitialize error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async onHttpServerStarted(httpServer: any): Promise<void> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHttpServerStarted!=null) await plugin.onHttpServerStarted(httpServer);
            } catch (e) {
                console.error("Plugin onHttpServerStarted error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async swapStateChange<T extends SwapData>(swap: SwapHandlerSwap<T>, oldState?: any) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapStateChange!=null) await plugin.onSwapStateChange(swap);
            } catch (e) {
                console.error("Plugin onSwapStateChange error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async swapCreate<T extends SwapData>(swap: SwapHandlerSwap<T>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapCreate!=null) await plugin.onSwapCreate(swap);
            } catch (e) {
                console.error("Plugin onSwapCreate error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async swapRemove<T extends SwapData>(swap: SwapHandlerSwap<T>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRemove!=null) await plugin.onSwapRemove(swap);
            } catch (e) {
                console.error("Plugin onSwapRemove error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async onSwapRequestToBtcLn?(req: Request & {paramReader: IParamReader}, requestData: ToBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
        let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRequestToBtcLn!=null) {
                    const result = await plugin.onSwapRequestToBtcLn(req, requestData, swapMetadata);
                    if(result!=null) {
                        if(result.throw) {
                            return {throw: result.throw}
                        }
                        if(result.baseFee!=null) fees.baseFee = result.baseFee;
                        if(result.feePPM!=null) fees.feePPM = result.feePPM;
                    }
                }
            } catch (e) {
                console.error("Plugin onSwapRequestToBtcLn error: ", plugin.name);
                console.error(e);
            }
        }
        return fees;
    }

    static async onSwapRequestToBtc?(req: Request & {paramReader: IParamReader}, requestData: ToBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
        let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRequestToBtc!=null) {
                    const result = await plugin.onSwapRequestToBtc(req, requestData, swapMetadata);
                    if(result!=null) {
                        if(result.throw) {
                            return {throw: result.throw}
                        }
                        if(result.baseFee!=null) fees.baseFee = result.baseFee;
                        if(result.feePPM!=null) fees.feePPM = result.feePPM;
                    }
                }
            } catch (e) {
                console.error("Plugin onSwapRequestToBtc error: ", plugin.name);
                console.error(e);
            }
        }
        return fees;
    }

    static async onSwapRequestFromBtcLn?(req: Request & {paramReader: IParamReader}, requestData: FromBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
        let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRequestFromBtcLn!=null) {
                    const result = await plugin.onSwapRequestFromBtcLn(req, requestData, swapMetadata);
                    if(result!=null) {
                        if(result.throw) {
                            return {throw: result.throw}
                        }
                        if(result.baseFee!=null) fees.baseFee = result.baseFee;
                        if(result.feePPM!=null) fees.feePPM = result.feePPM;
                    }
                }
            } catch (e) {
                console.error("Plugin onSwapRequestFromBtcLn error: ", plugin.name);
                console.error(e);
            }
        }
        return fees;
    }

    static async onSwapRequestFromBtc?(req: Request & {paramReader: IParamReader}, requestData: FromBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
        let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRequestFromBtc!=null) {
                    const result = await plugin.onSwapRequestFromBtc(req, requestData, swapMetadata);
                    if(result!=null) {
                        if(result.throw) {
                            return {throw: result.throw}
                        }
                        if(result.baseFee!=null) fees.baseFee = result.baseFee;
                        if(result.feePPM!=null) fees.feePPM = result.feePPM;
                    }
                }
            } catch (e) {
                console.error("Plugin onSwapRequestFromBtc error: ", plugin.name);
                console.error(e);
            }
        }
        return fees;
    }

    static getWhitelistedTxIds(): Set<string> {
        const whitelist: Set<string> = new Set<string>();

        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.getWhitelistedTxIds!=null) {
                    const result: string[] = plugin.getWhitelistedTxIds();
                    if(result!=null) {
                        result.forEach(e => whitelist.add(e));
                    }
                }
            } catch (e) {
                console.error("Plugin getWhitelistedTxIds error: ", plugin.name);
                console.error(e);
            }
        }

        return whitelist;
    }

}