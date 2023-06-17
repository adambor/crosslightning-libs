import * as bolt11 from "bolt11";
import {SoltoBTCLNWrapper} from "./SoltoBTCLNWrapper";
import {ISolToBTCxSwap} from "../ISolToBTCxSwap";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {SwapData} from "crosslightning-base";
import {decipherAES, LNURLPaySuccessAction} from "js-lnurl/lib";

export class SoltoBTCLNSwap<T extends SwapData> extends ISolToBTCxSwap<T> {

    readonly confidence: number;

    //State: PR_CREATED
    readonly pr: string;
    readonly routingFeeSats: BN;

    readonly lnurl: string;
    readonly successAction: LNURLPaySuccessAction;

    constructor(
        wrapper: SoltoBTCLNWrapper<T>,
        pr: string,
        data: T,
        swapFee: BN,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        url: string,
        confidence: string,
        routingFeeSats: BN,
        expiry: number,
        lnurl?: string,
        successAction?: LNURLPaySuccessAction
    );
    constructor(wrapper: SoltoBTCLNWrapper<T>, obj: any);

    constructor(
        wrapper: SoltoBTCLNWrapper<T>,
        prOrObject: string | any,
        data?: T,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
        confidence?: string,
        routingFeeSats?: BN,
        expiry?: number,
        lnurl?: string,
        successAction?: LNURLPaySuccessAction
    ) {
        if(typeof(prOrObject)==="string") {
            super(wrapper, data, swapFee, prefix, timeout, signature, nonce, url, expiry);
            this.confidence = parseFloat(confidence);
            this.pr = prOrObject;
            this.routingFeeSats = routingFeeSats;
            this.lnurl = lnurl;
            this.successAction = successAction;
        } else {
            super(wrapper, prOrObject);
            this.confidence = prOrObject.confidence;
            this.pr = prOrObject.pr;
            this.routingFeeSats = prOrObject.routingFeeSats==null ? null : new BN(prOrObject.routingFeeSats);
            this.lnurl = prOrObject.lnurl;
            this.successAction = prOrObject.successAction;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN {
        return this.data.getAmount();
    }

    getFee(): BN {
        return this.swapFee;
    }

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount(): BN {
        const parsedPR = bolt11.decode(this.pr);
        return new BN(parsedPR.satoshis);
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.confidence = this.confidence;
        partialSerialized.routingFeeSats = this.routingFeeSats==null ? null : this.routingFeeSats.toString(10);
        partialSerialized.lnurl = this.lnurl;
        partialSerialized.successAction = this.successAction;
        return partialSerialized;
    }

    /**
     * Returns routing fee in satoshis
     */
    getRoutingFee(): BN {
        return this.routingFeeSats;
    }

    /**
     * Returns the confidence of the intermediary that this payment will succeed
     * Value between 0 and 1, where 0 is not likely and 1 is very likely
     */
    getConfidence(): number {
        return this.confidence;
    }

    getPaymentHash(): Buffer {
        const parsed = bolt11.decode(this.pr);
        return Buffer.from(parsed.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        return this.pr;
    }

    getType(): SwapType {
        return SwapType.TO_BTCLN;
    }

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
     * Whether this payment contains a success message
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

}
