import {BitcoinRpc, BtcRelay, ChainEvents, SwapContract, SwapData, SwapEvent, TokenAddress} from "crosslightning-base";
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
    debug: (plugin: IPlugin<any>, msg, ...args) => logger.debug(plugin.name+": "+msg, ...args),
    info: (plugin: IPlugin<any>, msg, ...args) => logger.info(plugin.name+": "+msg, ...args),
    warn: (plugin: IPlugin<any>, msg, ...args) => logger.warn(plugin.name+": "+msg, ...args),
    error: (plugin: IPlugin<any>, msg, ...args) => logger.error(plugin.name+": "+msg, ...args)
};

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

    static async serviceInitialize<T extends SwapData>(handler: SwapHandler<any, T>) {
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
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: FromBtcLnRequestType | FromBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN},
        pricePrefetchPromise?: Promise<BN> | null
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | PluginQuote> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePostFromBtcQuote!=null) {
                    const result = await plugin.onHandlePostFromBtcQuote(request, requestedAmount, token, constraints, fees, pricePrefetchPromise);
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
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: FromBtcLnRequestType | FromBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePreFromBtcQuote!=null) {
                    const result = await plugin.onHandlePreFromBtcQuote(request, requestedAmount, token, constraints, fees);
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
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: ToBtcLnRequestType | ToBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN, networkFeeGetter: (amount: BN) => Promise<T>},
        pricePrefetchPromise?: Promise<BN> | null
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | (ToBtcPluginQuote & {networkFeeData: T})> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePostToBtcQuote!=null) {
                    let networkFeeData: T;
                    const result = await plugin.onHandlePostToBtcQuote(request, requestedAmount, token, constraints, {
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
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: ToBtcLnRequestType | ToBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh> {
        for(let plugin of PluginManager.plugins.values()) {
            try {
                if(plugin.onHandlePreToBtcQuote!=null) {
                    const result = await plugin.onHandlePreToBtcQuote(request, requestedAmount, token, constraints, fees);
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

    // static async onSwapRequestToBtcLn?(req: Request & {paramReader: IParamReader}, requestData: ToBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
    //     let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
    //     for(let plugin of PluginManager.plugins.values()) {
    //         try {
    //             if(plugin.onSwapRequestToBtcLn!=null) {
    //                 const result = await plugin.onSwapRequestToBtcLn(req, requestData, swapMetadata);
    //                 if(result!=null) {
    //                     if(result.throw) {
    //                         return {throw: result.throw}
    //                     }
    //                     if(result.baseFee!=null) fees.baseFee = result.baseFee;
    //                     if(result.feePPM!=null) fees.feePPM = result.feePPM;
    //                 }
    //             }
    //         } catch (e) {
    //             pluginLogger.error(plugin, "onSwapRequestToBtcLn(): plugin error", e);
    //         }
    //     }
    //     return fees;
    // }
    //
    // static async onSwapRequestToBtc?(req: Request & {paramReader: IParamReader}, requestData: ToBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
    //     let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
    //     for(let plugin of PluginManager.plugins.values()) {
    //         try {
    //             if(plugin.onSwapRequestToBtc!=null) {
    //                 const result = await plugin.onSwapRequestToBtc(req, requestData, swapMetadata);
    //                 if(result!=null) {
    //                     if(result.throw) {
    //                         return {throw: result.throw}
    //                     }
    //                     if(result.baseFee!=null) fees.baseFee = result.baseFee;
    //                     if(result.feePPM!=null) fees.feePPM = result.feePPM;
    //                 }
    //             }
    //         } catch (e) {
    //             pluginLogger.error(plugin, "onSwapRequestToBtc(): plugin error", e);
    //         }
    //     }
    //     return fees;
    // }
    //
    // static async onSwapRequestFromBtcLn?(req: Request & {paramReader: IParamReader}, requestData: FromBtcLnRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
    //     let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
    //     for(let plugin of PluginManager.plugins.values()) {
    //         try {
    //             if(plugin.onSwapRequestFromBtcLn!=null) {
    //                 const result = await plugin.onSwapRequestFromBtcLn(req, requestData, swapMetadata);
    //                 if(result!=null) {
    //                     if(result.throw) {
    //                         return {throw: result.throw}
    //                     }
    //                     if(result.baseFee!=null) fees.baseFee = result.baseFee;
    //                     if(result.feePPM!=null) fees.feePPM = result.feePPM;
    //                 }
    //             }
    //         } catch (e) {
    //             pluginLogger.error(plugin, "onSwapRequestFromBtcLn(): plugin error", e);
    //         }
    //     }
    //     return fees;
    // }
    //
    // static async onSwapRequestFromBtc?(req: Request & {paramReader: IParamReader}, requestData: FromBtcRequestType, swapMetadata: any): Promise<{throw?: string, baseFee?: BN, feePPM?: BN}> {
    //     let fees: {baseFee: BN, feePPM: BN} = {baseFee: null, feePPM: null};
    //     for(let plugin of PluginManager.plugins.values()) {
    //         try {
    //             if(plugin.onSwapRequestFromBtc!=null) {
    //                 const result = await plugin.onSwapRequestFromBtc(req, requestData, swapMetadata);
    //                 if(result!=null) {
    //                     if(result.throw) {
    //                         return {throw: result.throw}
    //                     }
    //                     if(result.baseFee!=null) fees.baseFee = result.baseFee;
    //                     if(result.feePPM!=null) fees.feePPM = result.feePPM;
    //                 }
    //             }
    //         } catch (e) {
    //             pluginLogger.error(plugin, "onSwapRequestFromBtc(): plugin error", e);
    //         }
    //     }
    //     return fees;
    // }

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