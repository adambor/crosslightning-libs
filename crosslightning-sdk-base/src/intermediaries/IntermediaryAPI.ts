import {RequestError} from "../errors/RequestError";
import * as BN from "bn.js";
import {
    FieldTypeEnum,
    RequestSchemaResult,
    verifySchema
} from "../utils/paramcoders/SchemaVerifier";
import {streamingFetchPromise} from "../utils/paramcoders/client/StreamingFetchPromise";
import {httpGet, httpPost, tryWithRetries} from "../utils/Utils";
import * as randomBytes from "randombytes";

export type InfoHandlerResponse = {
    address: string,
    envelope: string,
    signature: string,
    chains: {
        [chainIdentifier: string]: {
            address: string,
            signature: string
        }
    }
};

export enum RefundAuthorizationResponseCodes {
    EXPIRED=20010,
    REFUND_DATA=20000,
    NOT_FOUND=20007,
    PENDING=20008,
    PAID=20006
}

export enum PaymentAuthorizationResponseCodes {
    AUTH_DATA=10000,
    EXPIRED=10001,
    PAID=10002,
    PENDING=10003,
    ALREADY_COMMITTED=10004
}

export type RefundAuthorizationResponse = {
    code: RefundAuthorizationResponseCodes.PAID,
    msg: string,
    data: {
        secret?: string,
        txId?: string
    }
} | {
    code: RefundAuthorizationResponseCodes.REFUND_DATA,
    msg: string,
    data: {
        address: string,
        prefix: string,
        timeout: string,
        signature: string
    }
} | {
    code: Exclude<RefundAuthorizationResponseCodes, RefundAuthorizationResponseCodes.PAID | RefundAuthorizationResponseCodes.REFUND_DATA>,
    msg: string
};

export type PaymentAuthorizationResponse = {
    code: PaymentAuthorizationResponseCodes.AUTH_DATA,
    msg: string,
    data: {
        address: string,
        data: any,
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }
} | {
    code: Exclude<PaymentAuthorizationResponseCodes, PaymentAuthorizationResponseCodes.AUTH_DATA>,
    msg: string
};

const SwapResponseSchema = {
    data: FieldTypeEnum.Any,

    prefix: FieldTypeEnum.String,
    timeout: FieldTypeEnum.String,
    signature: FieldTypeEnum.String
} as const;

export type SwapInit = {
    token: string,
    additionalParams?: { [name: string]: any }
}

export type BaseFromBTCSwapInit = SwapInit & {
    claimer: string,
    amount: BN,
    exactOut: boolean,
    feeRate: Promise<string>
};

export type BaseToBTCSwapInit = SwapInit & {
    offerer: string
};

/////////////////////////
///// To BTC

const ToBTCResponseSchema = {
    amount: FieldTypeEnum.BN,
    address: FieldTypeEnum.String,
    satsPervByte: FieldTypeEnum.BN,
    networkFee: FieldTypeEnum.BN,
    swapFee: FieldTypeEnum.BN,
    totalFee: FieldTypeEnum.BN,
    total: FieldTypeEnum.BN,
    minRequiredExpiry: FieldTypeEnum.BN,
    ...SwapResponseSchema
} as const;

export type ToBTCResponseType = RequestSchemaResult<typeof ToBTCResponseSchema>;

export type ToBTCInit = BaseToBTCSwapInit & {
    btcAddress: string,
    exactIn: boolean,
    amount: BN,
    confirmationTarget: number,
    confirmations: number,
    nonce: BN,
    feeRate: Promise<string>
}

/////////////////////////
///// To BTCLN

const ToBTCLNResponseSchema = {
    maxFee: FieldTypeEnum.BN,
    swapFee: FieldTypeEnum.BN,
    total: FieldTypeEnum.BN,
    confidence: FieldTypeEnum.Number,
    address: FieldTypeEnum.String,

    routingFeeSats: FieldTypeEnum.BN,
    ...SwapResponseSchema
} as const;

export type ToBTCLNResponseType = RequestSchemaResult<typeof ToBTCLNResponseSchema>;

export type ToBTCLNInit = BaseToBTCSwapInit & {
    pr: string,
    maxFee: BN,
    expiryTimestamp: BN,
    feeRate: Promise<any>
};

const ToBTCLNPrepareExactInSchema = {
    amount: FieldTypeEnum.BN,
    reqId: FieldTypeEnum.String
} as const;

export type ToBTCLNPrepareExactInResponseType = RequestSchemaResult<typeof ToBTCLNPrepareExactInSchema>;

export type ToBTCLNPrepareExactIn = BaseToBTCSwapInit & {
    pr: string,
    amount: BN,
    maxFee: BN,
    expiryTimestamp: BN
}

export type ToBTCLNInitExactIn = {
    pr: string,
    reqId: string,
    feeRate: Promise<any>,
    additionalParams?: { [name: string]: any }
}

/////////////////////////
///// From BTC

const FromBTCResponseSchema = {
    amount: FieldTypeEnum.BN,
    btcAddress: FieldTypeEnum.String,
    address: FieldTypeEnum.String,
    swapFee: FieldTypeEnum.BN,
    total: FieldTypeEnum.BN,
    ...SwapResponseSchema
} as const;

export type FromBTCResponseType = RequestSchemaResult<typeof FromBTCResponseSchema>;

export type FromBTCInit = BaseFromBTCSwapInit & {
    sequence: BN,
    claimerBounty: Promise<{
        feePerBlock: BN,
        safetyFactor: number,
        startTimestamp: BN,
        addBlock: number,
        addFee: BN
    }>
}

/////////////////////////
///// From BTCLN

const FromBTCLNResponseSchema = {
    pr: FieldTypeEnum.String,
    swapFee: FieldTypeEnum.BN,
    total: FieldTypeEnum.BN,
    intermediaryKey: FieldTypeEnum.String,
    securityDeposit: FieldTypeEnum.BN
}

export type FromBTCLNResponseType = RequestSchemaResult<typeof FromBTCLNResponseSchema>;

export type FromBTCLNInit = BaseFromBTCSwapInit & {
    paymentHash: Buffer,
    descriptionHash?: Buffer
}

export class IntermediaryAPI {

    /**
     * Returns the information about a specific intermediary
     *
     * @param baseUrl Base URL of the intermediary
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     *
     * @throws {RequestError} If non-200 http response code is returned
     * @throws {Error} If the supplied nonce doesn't match the response
     */
    static async getIntermediaryInfo(
        baseUrl: string,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<InfoHandlerResponse> {
        const nonce = randomBytes(32).toString("hex");

        const response = await httpPost<InfoHandlerResponse>(baseUrl+"/info", {
            nonce,
        }, timeout, abortSignal);

        const info = JSON.parse(response.envelope);
        if(nonce!==info.nonce) throw new Error("Invalid response - nonce");

        return response;
    }

    /**
     * Returns the information about an outcome of the To BTC swap
     *
     * @param url URL of the intermediary
     * @param paymentHash Payment hash of the swap
     * @param sequence Swap's sequence number
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static async getRefundAuthorization(
        url: string,
        paymentHash: string,
        sequence: BN,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<RefundAuthorizationResponse> {
        return tryWithRetries(() => httpGet<RefundAuthorizationResponse>(
            url + "/getRefundAuthorization"+
                "?paymentHash=" + encodeURIComponent(paymentHash) +
                "&sequence=" + encodeURIComponent(sequence.toString(10)),
            timeout,
            abortSignal
        ), null, RequestError, abortSignal);
    }

    /**
     * Returns the information about the payment of the From BTCLN swaps
     *
     * @param url URL of the intermediary
     * @param paymentHash Payment hash of the swap
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static async getPaymentAuthorization(
        url: string,
        paymentHash: string,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<PaymentAuthorizationResponse> {
        return tryWithRetries(() => httpGet<PaymentAuthorizationResponse>(
            url+"/getInvoicePaymentAuth"+
                "?paymentHash="+encodeURIComponent(paymentHash),
            timeout,
            abortSignal
        ), null, RequestError, abortSignal);
    }

    /**
     * Initiate To BTC swap with an intermediary
     *
     * @param chainIdentifier
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static initToBTC(
        chainIdentifier: string,
        baseUrl: string,
        init: ToBTCInit,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCResponseType>
    } {
        const responseBodyPromise = streamingFetchPromise(baseUrl+"/tobtc/payInvoice?chain="+encodeURIComponent(chainIdentifier), {
            ...init.additionalParams,
            address: init.btcAddress,
            amount: init.amount.toString(10),
            exactIn: init.exactIn,
            confirmationTarget: init.confirmationTarget,
            confirmations: init.confirmations,
            nonce: init.nonce.toString(10),
            token: init.token,
            offerer: init.offerer,
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            signDataPrefetch: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, streamRequest);

        return {
            signDataPrefetch: responseBodyPromise.then(responseBody => responseBody.signDataPrefetch),
            response: responseBodyPromise.then((responseBody) => Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data,
            ])).then(([code, msg, data]) => {
                if(code!==20000) {
                    throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
                }
                return verifySchema(data, ToBTCResponseSchema);
            })
        };
    }

    /**
     * Initiate From BTC swap with an intermediary
     *
     * @param chainIdentifier
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static initFromBTC(
        chainIdentifier: string,
        baseUrl: string,
        init: FromBTCInit,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): {
        signDataPrefetch: Promise<any>,
        response: Promise<FromBTCResponseType>
    } {
        const responseBodyPromise = streamingFetchPromise(baseUrl+"/frombtc/getAddress?chain="+encodeURIComponent(chainIdentifier), {
            ...init.additionalParams,
            address: init.claimer,
            amount: init.amount.toString(10),
            token: init.token,

            exactOut: init.exactOut,
            sequence: init.sequence.toString(10),

            claimerBounty: init.claimerBounty.then(claimerBounty => {
                return {
                    feePerBlock: claimerBounty.feePerBlock.toString(10),
                    safetyFactor: claimerBounty.safetyFactor,
                    startTimestamp: claimerBounty.startTimestamp.toString(10),
                    addBlock: claimerBounty.addBlock,
                    addFee: claimerBounty.addFee.toString(10)
                }
            }),
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            signDataPrefetch: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, streamRequest);

        return {
            signDataPrefetch: responseBodyPromise.then(responseBody => responseBody.signDataPrefetch),
            response: responseBodyPromise.then((responseBody) => Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data,
            ])).then(([code, msg, data]) => {
                if(code!==20000) {
                    throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
                }
                return verifySchema(data, FromBTCResponseSchema);
            })
        };
    }

    /**
     * Initiate From BTCLN swap with an intermediary
     *
     * @param chainIdentifier
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static initFromBTCLN(
        chainIdentifier: string,
        baseUrl: string,
        init: FromBTCLNInit,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): {
        lnPublicKey: Promise<string>,
        response: Promise<FromBTCLNResponseType>
    } {
        const responseBodyPromise = streamingFetchPromise(baseUrl+"/frombtcln/createInvoice?chain="+encodeURIComponent(chainIdentifier), {
            ...init.additionalParams,
            paymentHash: init.paymentHash.toString("hex"),
            amount: init.amount.toString(),
            address: init.claimer,
            token: init.token,
            descriptionHash: init.descriptionHash==null ? null : init.descriptionHash.toString("hex"),
            exactOut: init.exactOut,
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            lnPublicKey: FieldTypeEnum.StringOptional
        }, timeout, abortSignal, streamRequest);

        return {
            lnPublicKey: responseBodyPromise.then(responseBody => responseBody.lnPublicKey),
            response: responseBodyPromise.then((responseBody) => Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data,
            ])).then(([code, msg, data]) => {
                if(code!==20000) {
                    throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
                }
                return verifySchema(data, FromBTCLNResponseSchema);
            })
        };
    }

    /**
     * Initiate To BTCLN swap with an intermediary
     *
     * @param chainIdentifier
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static initToBTCLN(
        chainIdentifier: string,
        baseUrl: string,
        init: ToBTCLNInit,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCLNResponseType>
    } {
        const responseBodyPromise = streamingFetchPromise(baseUrl+"/tobtcln/payInvoice?chain="+encodeURIComponent(chainIdentifier), {
            exactIn: false,
            ...init.additionalParams,
            pr: init.pr,
            maxFee: init.maxFee.toString(10),
            expiryTimestamp: init.expiryTimestamp.toString(10),
            token: init.token,
            offerer: init.offerer,
            feeRate: init.feeRate,
            amount: null
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            signDataPrefetch: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, streamRequest);

        return {
            signDataPrefetch: responseBodyPromise.then(responseBody => responseBody.signDataPrefetch),
            response: responseBodyPromise.then((responseBody) => Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data,
            ])).then(([code, msg, data]) => {
                if(code!==20000) {
                    throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
                }
                return verifySchema(data, ToBTCLNResponseSchema);
            })
        };
    }

    /**
     * Initiate To BTCLN exact in swap with an intermediary
     *
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static async initToBTCLNExactIn(
        baseUrl: string,
        init: ToBTCLNInitExactIn,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): Promise<ToBTCLNResponseType> {
        const responseBody = await streamingFetchPromise(baseUrl+"/tobtcln/payInvoiceExactIn", {
            ...init.additionalParams,
            pr: init.pr,
            reqId: init.reqId,
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, streamRequest);

        const [code, msg, data] = await Promise.all([
            responseBody.code,
            responseBody.msg,
            responseBody.data,
        ])

        if(code!==20000) throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
        return verifySchema(data, ToBTCLNResponseSchema);
    }

    /**
     * Prepare To BTCLN exact in swap with an intermediary
     *
     * @param chainIdentifier
     * @param baseUrl Base URL of the intermediary
     * @param init Swap initialization parameters
     * @param timeout Timeout in milliseconds for the HTTP request
     * @param abortSignal
     * @param streamRequest Whether to force streaming (or not streaming) the request, default is autodetect
     *
     * @throws {RequestError} If non-200 http response code is returned
     */
    static prepareToBTCLNExactIn(
        chainIdentifier: string,
        baseUrl: string,
        init: ToBTCLNPrepareExactIn,
        timeout?: number,
        abortSignal?: AbortSignal,
        streamRequest?: boolean
    ): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCLNPrepareExactInResponseType>
    } {
        const responseBodyPromise = streamingFetchPromise(baseUrl+"/tobtcln/payInvoice?chain="+encodeURIComponent(chainIdentifier), {
            exactIn: true,
            ...init.additionalParams,
            pr: init.pr,
            maxFee: init.maxFee.toString(10),
            expiryTimestamp: init.expiryTimestamp.toString(10),
            token: init.token,
            offerer: init.offerer,
            amount: init.amount.toString(10)
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            signDataPrefetch: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, streamRequest);

        return {
            signDataPrefetch: responseBodyPromise.then(responseBody => responseBody.signDataPrefetch),
            response: responseBodyPromise.then((responseBody) => Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data,
            ])).then(([code, msg, data]) => {
                if(code!==20000) {
                    throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
                }
                return verifySchema(data, ToBTCLNPrepareExactInSchema);
            })
        };
    }

}