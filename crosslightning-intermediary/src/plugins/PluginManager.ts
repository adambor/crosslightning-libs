import {BitcoinRpc, SwapData} from "crosslightning-base";
import {
    IPlugin, isPluginQuote, isQuoteAmountTooHigh, isQuoteAmountTooLow, isQuoteSetFees,
    isQuoteThrow, isToBtcPluginQuote, PluginQuote,
    QuoteAmountTooHigh,
    QuoteAmountTooLow,
    QuoteSetFees,
    QuoteThrow, ToBtcPluginQuote
} from "./IPlugin";
import {
    FromBtcLnRequestType,
    FromBtcRequestType,
    ISwapPrice, MultichainData, RequestData,
    SwapHandler,
    ToBtcLnRequestType,
    ToBtcRequestType
} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";
import {AuthenticatedLnd} from "lightning";
import * as BN from "bn.js";
import * as fs from "fs";
import {getLogger} from "../utils/Utils";

export type FailSwapResponse = {
    type: "fail",
    code?: number,
    msg?: string
};

export type FeeSwapResponse = {
    type: "fee",
    baseFee: BN,
    feePPM: BN
};

export type AmountAndFeeSwapResponse = {
    type: "amountAndFee",
    baseFee?: BN,
    feePPM?: BN,
    amount: BN
};

export type SwapResponse = FailSwapResponse | FeeSwapResponse | AmountAndFeeSwapResponse;

const logger = getLogger("PluginManager: ");
const pluginLogger = {
    debug: (plugin: IPlugin, msg, ...args) => logger.debug(plugin.name+": "+msg, ...args),
    info: (plugin: IPlugin, msg, ...args) => logger.info(plugin.name+": "+msg, ...args),
    warn: (plugin: IPlugin, msg, ...args) => logger.warn(plugin.name+": "+msg, ...args),
    error: (plugin: IPlugin, msg, ...args) => logger.error(plugin.name+": "+msg, ...args)
};

export class PluginManager {

    static plugins: Map<string, IPlugin> = new Map();

    static registerPlugin(name: string, plugin: IPlugin) {
        PluginManager.plugins.set(name, plugin);
    }

    static unregisterPlugin(name: string): boolean {
        return PluginManager.plugins.delete(name);
    }

    static async enable<T extends SwapData>(
        chainsData: MultichainData,

        bitcoinRpc: BitcoinRpc<any>,
        lnd: AuthenticatedLnd,

        swapPricing: ISwapPrice,
        tokens: {
            [ticker: string]: {
                [chainId: string]: {
                    address: string,
                    decimals: number
                }
            }
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
                    chainsData,
                    bitcoinRpc,
                    lnd,
                    swapPricing,
                    tokens,
                    directory+"/"+name
                );
            } catch (e) {
                pluginLogger.error(plugin, "enable(): plugin enable error", e);
            }
        }
    }

    static async disable() {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                await plugin.onDisable();
            } catch (e) {
                pluginLogger.error(plugin, "disable(): plugin disable error", e);
            }
        }
    }

    static async serviceInitialize(handler: SwapHandler<any>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                await plugin.onServiceInitialize(handler);
            } catch (e) {
                pluginLogger.error(plugin, "serviceInitialize(): plugin error", e);
            }
        }
    }

    static async onHttpServerStarted(httpServer: any): Promise<void> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHttpServerStarted!=null) await plugin.onHttpServerStarted(httpServer);
            } catch (e) {
                pluginLogger.error(plugin, "onHttpServerStarted(): plugin error", e);
            }
        }
    }

    static async swapStateChange<T extends SwapData>(swap: SwapHandlerSwap<T>, oldState?: any) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapStateChange!=null) await plugin.onSwapStateChange(swap);
            } catch (e) {
                pluginLogger.error(plugin, "swapStateChange(): plugin error", e);
            }
        }
    }

    static async swapCreate<T extends SwapData>(swap: SwapHandlerSwap<T>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapCreate!=null) await plugin.onSwapCreate(swap);
            } catch (e) {
                pluginLogger.error(plugin, "swapCreate(): plugin error", e);
            }
        }
    }

    static async swapRemove<T extends SwapData>(swap: SwapHandlerSwap<T>) {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onSwapRemove!=null) await plugin.onSwapRemove(swap);
            } catch (e) {
                pluginLogger.error(plugin, "swapRemove(): plugin error", e);
            }
        }
    }

    static async onHandlePostFromBtcQuote(
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        chainIdentifier: string,
        token: string,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN},
        pricePrefetchPromise?: Promise<BN> | null
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | PluginQuote> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePostFromBtcQuote!=null) {
                    const result = await plugin.onHandlePostFromBtcQuote(request, requestedAmount, chainIdentifier, token, constraints, fees, pricePrefetchPromise);
                    if(result!=null) {
                        if(isQuoteSetFees(result)) return result;
                        if(isQuoteThrow(result)) return result;
                        if(isQuoteAmountTooHigh(result)) return result;
                        if(isQuoteAmountTooLow(result)) return result;
                        if(isPluginQuote(result)) {
                            if(result.amount.input===requestedAmount.input) throw new Error("Invalid quoting response returned, when input is set, output must be returned, and vice-versa!");
                            return result;
                        }
                    }
                }
            } catch (e) {
                pluginLogger.error(plugin, "onSwapRequestToBtcLn(): plugin error", e);
            }
        }
        return null;
    }

    static async onHandlePreFromBtcQuote(
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        chainIdentifier: string,
        token: string,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePreFromBtcQuote!=null) {
                    const result = await plugin.onHandlePreFromBtcQuote(request, requestedAmount, chainIdentifier, token, constraints, fees);
                    if(result!=null) {
                        if(isQuoteSetFees(result)) return result;
                        if(isQuoteThrow(result)) return result;
                        if(isQuoteAmountTooHigh(result)) return result;
                        if(isQuoteAmountTooLow(result)) return result;
                    }
                }
            } catch (e) {
                pluginLogger.error(plugin, "onSwapRequestToBtcLn(): plugin error", e);
            }
        }
        return null;
    }

    static async onHandlePostToBtcQuote<T extends {networkFee: BN}>(
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        chainIdentifier: string,
        token: string,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN, networkFeeGetter: (amount: BN) => Promise<T>},
        pricePrefetchPromise?: Promise<BN> | null
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | (ToBtcPluginQuote & {networkFeeData: T})> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePostToBtcQuote!=null) {
                    let networkFeeData: T;
                    const result = await plugin.onHandlePostToBtcQuote(request, requestedAmount, chainIdentifier, token, constraints, {
                        baseFeeInBtc: fees.baseFeeInBtc,
                        feePPM: fees.feePPM,
                        networkFeeGetter: async (amount: BN) => {
                            networkFeeData = await fees.networkFeeGetter(amount);
                            return networkFeeData.networkFee;
                        }
                    }, pricePrefetchPromise);
                    if(result!=null) {
                        if(isQuoteSetFees(result)) return result;
                        if(isQuoteThrow(result)) return result;
                        if(isQuoteAmountTooHigh(result)) return result;
                        if(isQuoteAmountTooLow(result)) return result;
                        if(isToBtcPluginQuote(result)) {
                            if(result.amount.input===requestedAmount.input) throw new Error("Invalid quoting response returned, when input is set, output must be returned, and vice-versa!");
                            return {
                                ...result,
                                networkFeeData: networkFeeData
                            };
                        }
                    }
                }
            } catch (e) {
                pluginLogger.error(plugin, "onSwapRequestToBtcLn(): plugin error", e);
            }
        }
        return null;
    }

    static async onHandlePreToBtcQuote(
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        chainIdentifier: string,
        token: string,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePreToBtcQuote!=null) {
                    const result = await plugin.onHandlePreToBtcQuote(request, requestedAmount, chainIdentifier, token, constraints, fees);
                    if(result!=null) {
                        if(isQuoteSetFees(result)) return result;
                        if(isQuoteThrow(result)) return result;
                        if(isQuoteAmountTooHigh(result)) return result;
                        if(isQuoteAmountTooLow(result)) return result;
                    }
                }
            } catch (e) {
                pluginLogger.error(plugin, "onSwapRequestToBtcLn(): plugin error", e);
            }
        }
        return null;
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
                pluginLogger.error(plugin, "getWhitelistedTxIds(): plugin error", e);
            }
        }

        return whitelist;
    }

}