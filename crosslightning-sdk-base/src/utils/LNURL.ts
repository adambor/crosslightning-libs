import {httpGet, tryWithRetries} from "./RetryUtils";
import {RequestError} from "../errors/RequestError";
import {findlnurl, getParams, LNURLPayParams, LNURLWithdrawParams, LNURLPaySuccessAction} from "js-lnurl";
import * as BN from "bn.js";
import {decode as bolt11Decode, PaymentRequestObject, TagsObject} from "bolt11";
import createHash from "create-hash";
import {LNURLPayResult} from "js-lnurl/lib/types";
import {UserError} from "../errors/UserError";

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

    private static isBareLNURL(str: string): boolean {
        try {
            return str.startsWith("lnurlw://") || str.startsWith("lnurlp://");
        } catch(e) {}
        return false;
    }

    private static isLightningAddress(str: string): boolean {
        return MAIL_REGEX.test(str);
    }

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
                await tryWithRetries(sendRequest, null, e => e instanceof RequestError, abortSignal) :
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

    static isLNURL(str: string): boolean {
        return findlnurl(str)!=null || LNURL.isLightningAddress(str) || LNURL.isBareLNURL(str);
    }

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
            null, e => e instanceof RequestError, abortSignal
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
            null, e => e instanceof RequestError
        );

        if(isLNURLError(response)) throw new RequestError("LNURL callback error: " + response.reason, 200);
    }

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