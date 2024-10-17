import {BitcoinRpc, BtcRelay, ChainEvents, SwapContract, SwapData, TokenAddress} from "crosslightning-base";
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
import {Command} from "crosslightning-server-base";
import {Request} from "express";

export type QuoteThrow = {
    type: "throw",
    message: string
}

export function isQuoteThrow(obj: any): obj is QuoteThrow {
    return obj.type==="throw" && typeof(obj.message)==="string";
}

export type QuoteSetFees = {
    type: "fees"
    baseFee?: BN,
    feePPM?: BN
};

export function isQuoteSetFees(obj: any): obj is QuoteSetFees {
    return obj.type==="fees" &&
        (obj.baseFee==null || BN.isBN(obj.baseFee)) &&
        (obj.feePPM==null || BN.isBN(obj.feePPM));
}

export type QuoteAmountTooLow = {
    type: "low",
    data: { min: BN, max: BN }
}

export function isQuoteAmountTooLow(obj: any): obj is QuoteAmountTooLow {
    return obj.type==="low" && typeof(obj.data)==="object" && BN.isBN(obj.data.min) && BN.isBN(obj.data.max);
}

export type QuoteAmountTooHigh = {
    type: "high",
    data: { min: BN, max: BN }
}

export function isQuoteAmountTooHigh(obj: any): obj is QuoteAmountTooHigh {
    return obj.type==="high" && typeof(obj.data)==="object" && BN.isBN(obj.data.min) && BN.isBN(obj.data.max);
}

export type PluginQuote = {
    type: "success",
    amount: {input: boolean, amount: BN},
    swapFee: { inInputTokens: BN, inOutputTokens: BN }
};

export function isPluginQuote(obj: any): obj is PluginQuote {
    return obj.type==="success" &&
        typeof(obj.amount)==="object" && typeof(obj.amount.input)==="boolean" && BN.isBN(obj.amount.amount) &&
        typeof(obj.swapFee)==="object" && BN.isBN(obj.swapFee.inInputTokens) && BN.isBN(obj.swapFee.inOutputTokens);
}

export type ToBtcPluginQuote = PluginQuote & {
    networkFee: { inInputTokens: BN, inOutputTokens: BN }
}

export function isToBtcPluginQuote(obj: any): obj is ToBtcPluginQuote {
    return typeof(obj.networkFee)==="object" && BN.isBN(obj.networkFee.inInputTokens) && BN.isBN(obj.networkFee.inOutputTokens) &&
        isPluginQuote(obj);
}

export interface IPlugin<T extends SwapData> {

    name: string;
    author: string;
    description: string;

    //Needs to be called by implementation
    onEnable(
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
    ): Promise<void>;
    onDisable(): Promise<void>;

    //Called in the library
    onServiceInitialize(service: SwapHandler<any, T>): Promise<void>;

    onHttpServerStarted?(expressServer: any): Promise<void>;

    onSwapStateChange?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapCreate?(swap: SwapHandlerSwap<T>): Promise<void>;
    onSwapRemove?(swap: SwapHandlerSwap<T>): Promise<void>;

    onHandlePreFromBtcQuote?(
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: FromBtcLnRequestType | FromBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    onHandlePostFromBtcQuote?(
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
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | PluginQuote>;

    onHandlePreToBtcQuote?(
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: ToBtcLnRequestType | ToBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    onHandlePostToBtcQuote?(
        request: {
            raw: Request & {paramReader: IParamReader},
            parsed: ToBtcLnRequestType | ToBtcRequestType,
            metadata: any
        },
        requestedAmount: {input: boolean, amount: BN},
        token: TokenAddress,
        constraints: {minInBtc: BN, maxInBtc: BN},
        fees: {baseFeeInBtc: BN, feePPM: BN, networkFeeGetter: (amount: BN) => Promise<BN>},
        pricePrefetchPromise?: Promise<BN> | null
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | ToBtcPluginQuote>;

    /**
     * Returns whitelisted bitcoin txIds that are OK to spend even with 0-confs
     */
    getWhitelistedTxIds?(): string[];

    getCommands?(): Command<any>[];

}
