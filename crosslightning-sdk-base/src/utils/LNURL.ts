import {RequestError} from "../errors/RequestError";
import {findlnurl, getParams, LNURLPayParams, LNURLWithdrawParams, LNURLPaySuccessAction} from "js-lnurl";
import * as BN from "bn.js";
import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import createHash from "create-hash";
import {LNURLPayResult} from "js-lnurl/lib/types";
import {UserError} from "../errors/UserError";
import {httpGet, tryWithRetries} from "./Utils";

export type LNURLWithdrawParamsWithUrl = LNURLWithdrawParams & {url: string};
export type LNURLPayParamsWithUrl = LNURLPayParams & {url: string};

export type LNURLPay = {
    type: "pay",
    min: BN,
    max: BN,
    commentMaxLength: number,
    shortDescription: string,
    longDescription?: string,
    icon?: string,
    params: LNURLPayParamsWithUrl
}

export type LNURLWithdraw= {
    type: "withdraw",
    min: BN,
    max: BN,
    params: LNURLWithdrawParamsWithUrl
}

export type LNURLOk = {
    status: "OK"
};

export type LNURLError = {
    status: "ERROR",
    reason?: string
};

export function isLNURLError(obj: any): obj is LNURLError {
    return obj.status==="ERROR" &&
        (obj.reason==null || typeof obj.reason==="string");
}

export function isLNURLPayParams(obj: any): obj is LNURLPayParams {
    return obj.tag==="payRequest";
}

export function isLNURLWithdrawParams(obj: any): obj is LNURLWithdrawParams {
    return obj.tag==="withdrawRequest";
}

export function isLNURLPayResult(obj: LNURLPayResult, domain?: string): obj is LNURLPayResult {
    return typeof obj.pr==="string" &&
        (obj.routes==null || Array.isArray(obj.routes)) &&
        (obj.disposable===null || obj.disposable===undefined || typeof obj.disposable==="boolean") &&
        (obj.successAction==null || isLNURLPaySuccessAction(obj.successAction, domain));
}

export function isLNURLPaySuccessAction(obj: any, domain?: string): obj is LNURLPaySuccessAction {
    switch(obj.tag) {
        case "message":
            return obj.message!=null && obj.message.length<=144;
        case "url":
            return obj.description!=null && obj.description.length<=144 &&
                obj.url!=null &&
                (domain==null || new URL(obj.url).hostname===domain);
        case "aes":
            return obj.description!=null && obj.description.length<=144 &&
                obj.ciphertext!=null && obj.ciphertext.length<=4096 && BASE64_REGEX.test(obj.ciphertext) &&
                obj.iv!=null && obj.iv.length<=24 && BASE64_REGEX.test(obj.iv);
        default:
            //Unsupported action
            return false;
    }
}

export const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const MAIL_REGEX = /(?:[A-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[A-z0-9](?:[A-z0-9-]*[A-z0-9])?\.)+[A-z0-9](?:[A-z0-9-]*[A-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[A-z0-9-]*[A-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export class LNURL {

    /**
     * Checks whether a provided string is bare (non bech32 encoded) lnurl
     * @param str
     * @private
     */
    private static isBareLNURL(str: string): boolean {
        try {
            return str.startsWith("lnurlw://") || str.startsWith("lnurlp://");
        } catch(e) {}
        return false;
    }

    /**
     * Checks if the provided string is a lightning network address (e.g. satoshi@nakamoto.com)
     * @param str
     * @private
     */
    private static isLightningAddress(str: string): boolean {
        return MAIL_REGEX.test(str);
    }

    /**
     * Checks whether a given string is a LNURL or lightning address
     * @param str
     */
    static isLNURL(str: string): boolean {
        return findlnurl(str)!=null || LNURL.isLightningAddress(str) || LNURL.isBareLNURL(str);
    }

    /**
     * Extracts the URL that needs to be request from LNURL or lightning address
     * @param str
     * @private
     * @returns An URL to send the request to, or null if it cannot be parsed
     */
    private static extractCallUrl(str: string): string | null {
        if(MAIL_REGEX.test(str)) {
            //lightning e-mail like address
            const arr = str.split("@");
            const username = arr[0];
            const domain = arr[1];
            let scheme = "https";
            if(domain.endsWith(".onion")) {
                scheme = "http";
            }

            return scheme+"://"+domain+"/.well-known/lnurlp/"+username;
        } else if(LNURL.isBareLNURL(str)) {
            //non-bech32m encoded lnurl
            const data = str.substring("lnurlw://".length);
            const httpUrl = new URL("http://"+data);

            let scheme = "https";
            if(httpUrl.hostname.endsWith(".onion")) {
                scheme = "http";
            }

            return scheme+"://"+data;
        }
        return null;
    }

    /**
     * Sends a request to obtain data about a specific LNURL or lightning address
     *
     * @param str A lnurl or lightning address
     * @param shouldRetry Whether we should retry in case of network failure
     * @param timeout Request timeout in milliseconds
     * @param abortSignal
     */
    static async getLNURL(
        str: string,
        shouldRetry: boolean = true,
        timeout?: number,
        abortSignal?: AbortSignal
    ) : Promise<LNURLPayParamsWithUrl | LNURLWithdrawParamsWithUrl | null> {
        if(shouldRetry==null) shouldRetry = true;

        let res: LNURLPayParams | LNURLWithdrawParams;
        const url: string = LNURL.extractCallUrl(str);
        if(url!=null) {
            const sendRequest =
                () => httpGet<LNURLPayParams | LNURLWithdrawParams | LNURLError>(url, timeout, abortSignal);

            let response = shouldRetry ?
                await tryWithRetries(sendRequest, null, RequestError, abortSignal) :
                await sendRequest();

            if(isLNURLError(response)) {
                return null;
            }

            if(response.tag==="payRequest") {
                try {
                    response.decodedMetadata = JSON.parse(response.metadata)
                } catch (err) {
                    response.decodedMetadata = []
                }
            }

            res = response;
        } else {
            const lnurl = findlnurl(str);
            if(lnurl==null) return null;
            const response = await getParams(lnurl);
            if(!isLNURLPayParams(response) || !isLNURLWithdrawParams(response)) return null;

            res = response;
        }

        return {
            ...res,
            url: str
        };
    }

    /**
     * Sends a request to obtain data about a specific LNURL or lightning address
     *
     * @param str A lnurl or lightning address
     * @param shouldRetry Whether we should retry in case of network failure
     * @param timeout Request timeout in milliseconds
     * @param abortSignal
     */
    static async getLNURLType(str: string, shouldRetry?: boolean, timeout?: number, abortSignal?: AbortSignal): Promise<LNURLPay | LNURLWithdraw | null> {
        let res: any = await LNURL.getLNURL(str, shouldRetry, timeout, abortSignal);

        if(res.tag==="payRequest") {
            const payRequest: LNURLPayParamsWithUrl = res;
            let shortDescription: string;
            let longDescription: string;
            let icon: string;
            payRequest.decodedMetadata.forEach(data => {
                switch(data[0]) {
                    case "text/plain":
                        shortDescription = data[1];
                        break;
                    case "text/long-desc":
                        longDescription = data[1];
                        break;
                    case "image/png;base64":
                        icon = "data:"+data[0]+","+data[1];
                        break;
                    case "image/jpeg;base64":
                        icon = "data:"+data[0]+","+data[1];
                        break;
                }
            });
            return {
                type: "pay",
                min: new BN(payRequest.minSendable).div(new BN(1000)),
                max: new BN(payRequest.maxSendable).div(new BN(1000)),
                commentMaxLength: payRequest.commentAllowed || 0,
                shortDescription,
                longDescription,
                icon,
                params: payRequest
            }
        }
        if(res.tag==="withdrawRequest") {
            const payRequest: LNURLWithdrawParamsWithUrl = res;
            return {
                type: "withdraw",
                min: new BN(payRequest.minWithdrawable).div(new BN(1000)),
                max: new BN(payRequest.maxWithdrawable).div(new BN(1000)),
                params: payRequest
            }
        }
        return null;
    }

    /**
     * Uses a LNURL-pay request by obtaining a lightning network invoice from it
     *
     * @param payRequest LNURL params as returned from the getLNURL call
     * @param amount Amount of sats (BTC) to pay
     * @param comment Optional comment for the payment request
     * @param timeout Request timeout in milliseconds
     * @param abortSignal
     * @throws {RequestError} If the response is non-200, status: ERROR, or invalid format
     */
    static async useLNURLPay(
        payRequest: LNURLPayParamsWithUrl,
        amount: BN,
        comment?: string,
        timeout?: number,
        abortSignal?: AbortSignal
    ): Promise<{
        invoice: string,
        parsedInvoice: PaymentRequestObject & { tagsObject: TagsObject; },
        successAction?: LNURLPaySuccessAction
    }> {
        const params = ["amount="+amount.mul(new BN(1000)).toString(10)];
        if(comment!=null) {
            params.push("comment="+encodeURIComponent(comment));
        }

        const queryParams = (payRequest.callback.includes("?") ? "&" : "?")+params.join("&");

        const response = await tryWithRetries(
            () => httpGet<LNURLPayResult | LNURLError>(payRequest.callback+queryParams, timeout, abortSignal),
            null, RequestError, abortSignal
        );

        if(isLNURLError(response)) throw new RequestError("LNURL callback error: "+response.reason, 200);
        if(!isLNURLPayResult(response)) throw new RequestError("Invalid LNURL response!", 200);

        const parsedPR = bolt11Decode(response.pr);

        const descHash = createHash("sha256").update(payRequest.metadata).digest().toString("hex");
        if(parsedPR.tagsObject.purpose_commit_hash!==descHash)
            throw new RequestError("Invalid invoice received (description hash)!", 200);

        const invoiceMSats = new BN(parsedPR.millisatoshis);
        if(!invoiceMSats.eq(amount.mul(new BN(1000))))
            throw new RequestError("Invalid invoice received (amount)!", 200);

        return {
            invoice: response.pr,
            parsedInvoice: parsedPR,
            successAction: response.successAction
        }
    }

    /**
     * Submits the bolt11 lightning invoice to the lnurl withdraw url
     *
     * @param withdrawRequest Withdraw request to use
     * @param withdrawRequest.k1 K1 parameter
     * @param withdrawRequest.callback A URL to call
     * @param lnpr bolt11 lightning network invoice to submit to the withdrawal endpoint
     * @throws {RequestError} If the response is non-200 or status: ERROR
     */
    static async postInvoiceToLNURLWithdraw(
        withdrawRequest: {k1: string, callback: string},
        lnpr: string
    ): Promise<void> {
        const params = [
            "pr="+lnpr,
            "k1="+withdrawRequest.k1
        ];
        const queryParams = (withdrawRequest.callback.includes("?") ? "&" : "?")+params.join("&");

        const response = await tryWithRetries(
            () => httpGet<LNURLOk | LNURLError>(withdrawRequest.callback+queryParams),
            null, RequestError
        );

        if(isLNURLError(response)) throw new RequestError("LNURL callback error: " + response.reason, 200);
    }

    /**
     * Uses a LNURL-withdraw request by submitting a lightning network invoice to it
     *
     * @param withdrawRequest Withdrawal request as returned from getLNURL call
     * @param lnpr bolt11 lightning network invoice to submit to the withdrawal endpoint
     * @throws {UserError} In case the provided bolt11 lightning invoice has an amount that is out of bounds for
     *  the specified LNURL-withdraw request
     */
    static async useLNURLWithdraw(
        withdrawRequest: LNURLWithdrawParamsWithUrl,
        lnpr: string
    ): Promise<void> {
        const min = new BN(withdrawRequest.minWithdrawable).div(new BN(1000));
        const max = new BN(withdrawRequest.maxWithdrawable).div(new BN(1000));

        const parsedPR = bolt11Decode(lnpr);
        const amount = new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000));
        if(amount.lt(min)) throw new UserError("Invoice amount less than minimum LNURL-withdraw limit");
        if(amount.gt(max)) throw new UserError("Invoice amount more than maximum LNURL-withdraw limit");

        return await LNURL.postInvoiceToLNURLWithdraw(withdrawRequest, lnpr);
    }

}