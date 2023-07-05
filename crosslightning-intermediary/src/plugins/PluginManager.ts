import {BtcRelay, ChainEvents, RelaySynchronizer, SwapContract, SwapData} from "crosslightning-base";
import {IPlugin} from "./IPlugin";
import {SwapHandler} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";


export class PluginManager {

    static plugins: IPlugin<any>[] = [];

    static registerPlugin(plugin: IPlugin<any>) {
        PluginManager.plugins.push(plugin);
    }

    static unregisterPlugin(plugin: IPlugin<any>) {
        const index = PluginManager.plugins.indexOf(plugin);
        if(index>-1) {
            PluginManager.plugins.splice(index, 1);
        }
    }

    static async enable<T extends SwapData>(
        swapContract: SwapContract<T, any>,
        btcRelay: BtcRelay<any, any, any>,
        btcRelaySynchronizer: RelaySynchronizer<any, any, any>,
        chainEvents: ChainEvents<T>
    ) {
        for(let plugin of PluginManager.plugins) {
            try {
                await plugin.onEnable(
                    swapContract,
                    btcRelay,
                    btcRelaySynchronizer,
                    chainEvents
                );
            } catch (e) {
                console.error("Plugin ENABLE error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async disable() {
        for(let plugin of PluginManager.plugins) {
            try {
                await plugin.onDisable();
            } catch (e) {
                console.error("Plugin DISABLE error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async serviceInitialize<T extends SwapData>(handler: SwapHandler<any, T>) {
        for(let plugin of PluginManager.plugins) {
            try {
                await plugin.onServiceInitialize(handler);
            } catch (e) {
                console.error("Plugin onServiceInitialize error: ", plugin.name);
                console.error(e);
            }
        }
    }

    static async swapStateChange<T extends SwapData>(swap: SwapHandlerSwap<T>, oldState?: any) {
        for(let plugin of PluginManager.plugins) {
            try {
                await plugin.onSwapStateChange(swap);
            } catch (e) {
                console.error("Plugin onSwapStateChange error: ", plugin.name);
                console.error(e);
            }
        }
    }

}