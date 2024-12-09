import {decode as bolt11Decode} from "bolt11";
import {ToBTCLNWrapper} from "./ToBTCLNWrapper";
import {isIToBTCSwapInit, IToBTCSwap, IToBTCSwapInit} from "../IToBTCSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {ChainType, SwapData} from "crosslightning-base";
import {Buffer} from "buffer";
import * as createHash from "create-hash";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {LNURL, LNURLDecodedSuccessAction, LNURLPaySuccessAction, isLNURLPaySuccessAction} from "../../../utils/LNURL";
import {BtcToken, TokenAmount, Token, BitcoinTokens, toTokenAmount} from "../../Tokens";

export type ToBTCLNSwapInit<T extends SwapData> = IToBTCSwapInit<T> & {
    confidence: number;
    pr: string;
    lnurl?: string;
    successAction?: LNURLPaySuccessAction;
};

export function isToBTCLNSwapInit<T extends SwapData>(obj: any): obj is ToBTCLNSwapInit<T> {
    return typeof (obj.confidence) === "number" &&
        typeof (obj.pr) === "string" &&
        (obj.lnurl == null || typeof (obj.lnurl) === "string") &&
        (obj.successAction == null || isLNURLPaySuccessAction(obj.successAction)) &&
        isIToBTCSwapInit<T>(obj);
}

export class ToBTCLNSwap<T extends ChainType = ChainType> extends IToBTCSwap<T> {
    protected outputToken: BtcToken<true> = BitcoinTokens.BTCLN;
    protected readonly TYPE = SwapType.TO_BTCLN;

    private readonly confidence: number;
    private readonly pr: string;

    lnurl?: string;
    successAction?: LNURLPaySuccessAction;

    private secret?: string;

    constructor(wrapper: ToBTCLNWrapper<T>, init: ToBTCLNSwapInit<T["Data"]>);
    constructor(wrapper: ToBTCLNWrapper<T>, obj: any);

    constructor(wrapper: ToBTCLNWrapper<T>, initOrObj: ToBTCLNSwapInit<T["Data"]> | any) {
        if(isToBTCLNSwapInit(initOrObj)) initOrObj.url += "/tobtcln";
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
        if(result==null) return Promise.resolve(false);
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

    getOutput(): TokenAmount<T["ChainId"], BtcToken<true>> {
        const parsedPR = bolt11Decode(this.pr);
        const amount = new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000));
        return toTokenAmount(amount, this.outputToken, this.wrapper.prices);
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
        if(this.pr==null) return null;
        const parsed = bolt11Decode(this.pr);
        return Buffer.from(parsed.tagsObject.payment_hash, "hex");
    }

    getRecipient(): string {
        return this.lnurl ?? this.pr;
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
    getSuccessAction(): LNURLDecodedSuccessAction | null {
        return LNURL.decodeSuccessAction(this.successAction, this.secret);
    }


    //////////////////////////////
    //// Storage

    serialize(): any {
        return {
            ...super.serialize(),
            pr: this.pr,
            confidence: this.confidence,
            secret: this.secret,
            lnurl: this.lnurl,
            successAction: this.successAction
        };
    }

}
