import {fetchWithTimeout, httpGet, httpPost, tryWithRetries} from "../utils/RetryUtils";
import {RequestError} from "../errors/RequestError";
import * as BN from "bn.js";
import {
    FieldTypeEnum,
    RequestSchema,
    RequestSchemaResult,
    RequestSchemaResultPromise, verifySchema
} from "../utils/paramcoders/SchemaVerifier";
import {RequestBody, streamingFetchWithTimeoutPromise} from "../utils/paramcoders/client/StreamingFetchPromise";
import {Psbt} from "bitcoinjs-lib";

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
        ), null, e => e instanceof RequestError, abortSignal);
    }

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
        ), null, e => e instanceof RequestError, abortSignal);
    }

    static initToBTC(url: string, init: ToBTCInit, timeout?: number, abortSignal?: AbortSignal): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCResponseType>
    } {
        const responseBodyPromise = streamingFetchWithTimeoutPromise(url+"/tobtc/payInvoice", {
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
        }, timeout, abortSignal, true);

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

    static initFromBTC(url: string, init: FromBTCInit, timeout?: number, abortSignal?: AbortSignal): {
        signDataPrefetch: Promise<any>,
        response: Promise<FromBTCResponseType>
    } {
        const responseBodyPromise = streamingFetchWithTimeoutPromise(url+"/frombtc/getAddress", {
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
        }, timeout, abortSignal, true);

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

    static initFromBTCLN(url: string, init: FromBTCLNInit, timeout?: number, abortSignal?: AbortSignal): {
        lnPublicKey: Promise<string>,
        response: Promise<FromBTCLNResponseType>
    } {
        const responseBodyPromise = streamingFetchWithTimeoutPromise(url+"/frombtcln/createInvoice", {
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
        }, timeout, abortSignal, true);

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

    static initToBTCLN(url: string, init: ToBTCLNInit, timeout?: number, abortSignal?: AbortSignal): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCLNResponseType>
    } {
        const responseBodyPromise = streamingFetchWithTimeoutPromise(url+"/tobtcln/payInvoice", {
            exactIn: false,
            ...init.additionalParams,
            pr: init.pr,
            maxFee: init.maxFee.toString(10),
            expiryTimestamp: init.expiryTimestamp.toString(10),
            token: init.token,
            offerer: init.offerer,
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional,
            signDataPrefetch: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, true);

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

    static async initToBTCLNExactIn(url: string, init: ToBTCLNInitExactIn, timeout?: number, abortSignal?: AbortSignal): Promise<ToBTCLNResponseType> {
        const responseBody = await streamingFetchWithTimeoutPromise(url+"/tobtcln/payInvoiceExactIn", {
            ...init.additionalParams,
            pr: init.pr,
            reqId: init.reqId,
            feeRate: init.feeRate
        }, {
            code: FieldTypeEnum.Number,
            msg: FieldTypeEnum.String,
            data: FieldTypeEnum.AnyOptional
        }, timeout, abortSignal, true);

        const [code, msg, data] = await Promise.all([
            responseBody.code,
            responseBody.msg,
            responseBody.data,
        ])

        if(code!==20000) throw RequestError.parse(JSON.stringify({code, msg, data}), 400);
        return verifySchema(data, ToBTCLNResponseSchema);
    }

    static prepareToBTCLNExactIn(
        url: string,
        init: ToBTCLNPrepareExactIn,
        timeout?: number,
        abortSignal?: AbortSignal
    ): {
        signDataPrefetch: Promise<any>,
        response: Promise<ToBTCLNPrepareExactInResponseType>
    } {
        const responseBodyPromise = streamingFetchWithTimeoutPromise(url+"/tobtcln/payInvoice", {
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
        }, timeout, abortSignal, true);

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