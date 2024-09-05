import {httpGet, tryWithRetries} from "../utils/Utils";
import {RequestError} from "../errors/RequestError";
import BN from "bn.js";
import {FieldTypeEnum, RequestSchemaResult, verifySchema} from "../utils/paramcoders/SchemaVerifier";

export enum InvoiceStatusResponseCodes {
    EXPIRED=10001,
    PAID=10000,
    AWAIT_PAYMENT=10010,
    PENDING=10011,
    TX_SENT=10012
}

export type InvoiceStatusResponse = {
    code: InvoiceStatusResponseCodes.TX_SENT | InvoiceStatusResponseCodes.PAID,
    msg: string,
    data: {
        txId: string
    }
} | {
    code: Exclude<InvoiceStatusResponseCodes, InvoiceStatusResponseCodes.TX_SENT | InvoiceStatusResponseCodes.PAID>,
    msg: string
};

export type TrustedFromBTCLNInit = {
    address: string,
    amount: BN
};

const TrustedFromBTCLNResponseSchema = {
    pr: FieldTypeEnum.String,
    swapFee: FieldTypeEnum.BN,
    total: FieldTypeEnum.BN
} as const;

export type TrustedFromBTCLNResponseType = RequestSchemaResult<typeof TrustedFromBTCLNResponseSchema>;

export class TrustedIntermediaryAPI {

    static async getInvoiceStatus(
        url: string,
        paymentHash: string,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<InvoiceStatusResponse> {
        return tryWithRetries(() => httpGet<InvoiceStatusResponse>(
            url+"/getInvoiceStatus?paymentHash="+encodeURIComponent(paymentHash),
            timeout, abortSignal
        ), null, RequestError, abortSignal);
    }

    static async initTrustedFromBTCLN(
        url: string,
        init: TrustedFromBTCLNInit,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<TrustedFromBTCLNResponseType> {
        const resp = await tryWithRetries(
            () => httpGet<{code: number, msg: string, data?: any}>(
                url+"/createInvoice" +
                    "?address="+encodeURIComponent(init.address)+"" +
                    "&amount="+encodeURIComponent(init.amount.toString(10)),
                timeout,
                abortSignal
            ), null, RequestError, abortSignal
        );

        if(resp.code!==10000) throw RequestError.parse(JSON.stringify(resp), 400);
        return verifySchema(resp.data, TrustedFromBTCLNResponseSchema);
    }

}