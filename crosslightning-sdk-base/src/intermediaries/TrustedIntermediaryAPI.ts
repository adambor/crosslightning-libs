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

    /**
     * Fetches the invoice status from the intermediary node
     *
     * @param url Url of the trusted intermediary
     * @param paymentHash Payment hash of the lightning invoice
     * @param timeout Timeout in milliseconds
     * @param abortSignal
     * @throws {RequestError} if non-200 http response is returned
     */
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

    /**
     * Initiate a trusted swap from BTCLN to SC native currency, retries!
     *
     * @param baseUrl Base url of the trusted swap intermediary
     * @param init Initialization parameters
     * @param timeout Timeout in milliseconds for the request
     * @param abortSignal
     * @throws {RequestError} If the response is non-200
     */
    static async initTrustedFromBTCLN(
        baseUrl: string,
        init: TrustedFromBTCLNInit,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<TrustedFromBTCLNResponseType> {
        const resp = await tryWithRetries(
            () => httpGet<{code: number, msg: string, data?: any}>(
                baseUrl+"/lnforgas/createInvoice" +
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