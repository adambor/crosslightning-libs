import {decode as bolt11Decode} from "bolt11";
import {ToBTCLNWrapper} from "./ToBTCLNWrapper";
import {isIToBTCSwapInit, IToBTCSwap, IToBTCSwapInit} from "../IToBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {decipherAES, LNURLPaySuccessAction} from "js-lnurl/lib";
import {Buffer} from "buffer";
import {Token} from "../../ISwap";
import createHash from "create-hash";
import {IntermediaryError} from "../../../errors/IntermediaryError";

function isLNURLPaySuccessAction(obj: any): obj is LNURLPaySuccessAction {
    return obj != null &&
        typeof obj === 'object' &&
        typeof obj.tag === 'string' &&
        (obj.description == null || typeof obj.description === 'string') &&
        (obj.url == null || typeof obj.url === 'string') &&
        (obj.message == null || typeof obj.message === 'string') &&
        (obj.ciphertext == null || typeof obj.ciphertext === 'string') &&
        (obj.iv == null || typeof obj.iv === 'string');
}

export type ToBTCLNSwapInit<T extends SwapData> = IToBTCSwapInit<T> & {
    confidence: number;
    pr: string;
    lnurl?: string;
    successAction?: LNURLPaySuccessAction;
};

export function isToBTCLNSwapInit<T extends SwapData>(obj: any): obj is ToBTCLNSwapInit<T> {
    return typeof(obj.confidence)==="number" &&
        typeof(obj.pr)==="string" &&
        (obj.lnurl==null || typeof(obj.lnurl)==="string") &&
        (obj.successAction==null || isLNURLPaySuccessAction(obj.successAction)) &&
        isIToBTCSwapInit<T>(obj);
}

export class ToBTCLNSwap<T extends SwapData> extends IToBTCSwap<T> {
    protected readonly TYPE = SwapType.TO_BTCLN;

    private readonly confidence: number;
    private readonly pr: string;

    lnurl?: string;
    successAction?: LNURLPaySuccessAction;

    private secret?: string;

    constructor(wrapper: ToBTCLNWrapper<T>, init: ToBTCLNSwapInit<T>);
    constructor(wrapper: ToBTCLNWrapper<T>, obj: any);

    constructor(wrapper: ToBTCLNWrapper<T>, initOrObj: ToBTCLNSwapInit<T> | any) {
        super(wrapper, initOrObj);
        if(!isToBTCLNSwapInit(initOrObj)) {
            this.confidence = initOrObj.confidence;
            this.pr = initOrObj.pr;
            this.lnurl = initOrObj.lnurl;
            this.successAction = initOrObj.successAction;
            this.secret = initOrObj.secret;
        }
        this.tryCalculateSwapFee();
    }

    _setPaymentResult(result: { secret?: string; txId?: string }, check: boolean = false): Promise<boolean> {
        if(result.secret==null) throw new IntermediaryError("No payment secret returned!");
        if(check) {
            const secretBuffer = Buffer.from(result.secret, "hex");
            const hash = createHash("sha256").update(secretBuffer).digest();

            const paymentHashBuffer = Buffer.from(this.data.getHash(), "hex");

            if(!hash.equals(paymentHashBuffer)) throw new IntermediaryError("Invalid payment secret returned");
        }
        this.secret = result.secret;
        return Promise.resolve(true);
    }


    //////////////////////////////
    //// Amounts & fees

    getOutAmount(): BN {
        const parsedPR = bolt11Decode(this.pr);
        return new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    getOutToken(): Token {
        return {
            chain: "BTC",
            lightning: true
        };
    }


    //////////////////////////////
    //// Getters & utils

    /**
     * Returns the lightning BOLT11 invoice where the BTC will be sent to
     */
    getLightningInvoice(): string {
        return this.pr;
    }

    /**
     * Returns payment secret (pre-image) as a proof of payment
     */
    getSecret(): string | null {
        return this.secret;
    }

    /**
     * Returns the confidence of the intermediary that this payment will succeed
     * Value between 0 and 1, where 0 is not likely and 1 is very likely
     */
    getConfidence(): number {
        return this.confidence;
    }

    getPaymentHash(): Buffer {
        const parsed = bolt11Decode(this.pr);
        return Buffer.from(parsed.tagsObject.payment_hash, "hex");
    }


    //////////////////////////////
    //// LNURL-pay

    /**
     * Is this an LNURL-pay swap?
     */
    isLNURL(): boolean {
        return this.lnurl!=null;
    }

    /**
     * Gets the used LNURL or null if this is not an LNURL-pay swap
     */
    getLNURL(): string | null {
        return this.lnurl;
    }

    /**
     * Checks whether this LNURL payment contains a success message
     */
    hasSuccessAction(): boolean {
        return this.successAction!=null;
    }

    /**
     * Returns the success action after a successful payment, else null
     */
    getSuccessAction(): {
        description: string,
        text?: string,
        url?: string
    } | null {
        if(this.secret==null) {
            return null;
        }
        if(this.successAction.tag==="message") {
            return {
                description: this.successAction.message
            };
        }
        if(this.successAction.tag==="url") {
            return {
                description: this.successAction.description,
                url: this.successAction.url
            };
        }
        if(this.successAction.tag==="aes") {
            const deciphered = decipherAES(this.successAction, this.secret);
            return {
                description: this.successAction.description,
                text: deciphered
            };
        }
    }


    //////////////////////////////
    //// Storage

    serialize(): any {
        return {
            ...super.serialize(),
            pr: this.pr,
            confidence: this.confidence,
            secret: this.secret
        };
    }

}
