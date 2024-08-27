import * as bolt11 from "bolt11";
import {SwapType} from "../../SwapType";
import * as BN from "bn.js";
import {StorageObject, SwapData} from "crosslightning-base";
import {fetchWithTimeout, tryWithRetries} from "../../../utils/RetryUtils";
import {PaymentAuthError} from "../../ClientSwapContract";
import {LnForGasWrapper} from "./LnForGasWrapper";
import {EventEmitter} from "events";
import {AbortError, RequestError} from "../../..";
import {Buffer} from "buffer";

const timeoutPromise = (timeoutSeconds) => {
    return new Promise(resolve => {
        setTimeout(resolve, timeoutSeconds*1000)
    });
};

export enum LnForGasSwapState {
    EXPIRED = -2,
    FAILED = -1,
    PR_CREATED = 0,
    FINISHED = 1
}

export class LnForGasSwap<T extends SwapData> implements StorageObject {

    state: LnForGasSwapState;

    wrapper: LnForGasWrapper<T>;
    readonly events: EventEmitter = new EventEmitter();

    //State: PR_CREATED
    readonly pr: string;
    readonly url: string;
    readonly outputAmount: BN;
    readonly swapFee: BN;
    readonly recipient: string;

    //State: FINISHED
    scTxId: string;

    constructor(
        wrapper: LnForGasWrapper<T>,
        pr: string,
        url: string,
        outputAmount: BN,
        swapFee: BN,
        recipient: string
    );
    constructor(obj: any);

    constructor(
        wrapperOrObject: LnForGasWrapper<T> | any,
        pr?: any,
        url?: string,
        outputAmount?: BN,
        swapFee?: BN,
        recipient?: string
    ) {
        if(wrapperOrObject instanceof LnForGasWrapper) {
            this.wrapper = wrapperOrObject;
            this.state = LnForGasSwapState.PR_CREATED;

            this.pr = pr;
            this.url = url;
            this.outputAmount = outputAmount;
            this.swapFee = swapFee;
            this.recipient = recipient;
        } else {
            this.state = wrapperOrObject.state;

            this.pr = wrapperOrObject.pr;
            this.url = wrapperOrObject.url;
            this.outputAmount = wrapperOrObject.outputAmount==null ? null : new BN(wrapperOrObject.outputAmount);
            this.swapFee = wrapperOrObject.swapFee==null ? null : new BN(wrapperOrObject.swapFee);
            this.recipient = wrapperOrObject.recipient;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN {
        return this.outputAmount;
    }

    /**
     * Returns amount that will be sent on Bitcoin LN
     */
    getInAmount(): BN {
        const parsed = bolt11.decode(this.pr);
        return new BN(parsed.millisatoshis).add(new BN(999)).div(new BN(1000));
    }

    serialize(): any{
        return {
            state: this.state,
            pr: this.pr,
            url: this.url,
            outputAmount: this.outputAmount==null ? null : this.outputAmount.toString(10),
            swapFee: this.swapFee==null ? null : this.swapFee.toString(10),
            recipient: this.recipient
        };
    }

    async getInvoiceStatus(
        abortSignal?: AbortSignal
    ): Promise<{
        is_paid: boolean,

        scTxId?: string
    }> {

        const decodedPR = bolt11.decode(this.pr);
        const paymentHash = decodedPR.tagsObject.payment_hash;

        const response: Response = await tryWithRetries(() => fetchWithTimeout(this.url+"/getInvoiceStatus?paymentHash="+encodeURIComponent(paymentHash), {
            method: "GET",
            signal: abortSignal,
            timeout: this.wrapper.options.getRequestTimeout
        }), null, null, abortSignal);

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json();

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(jsonBody.code===10000) {
            //tx id returned
            const scTxId = jsonBody.data.txId;
            //Check if it really is confirmed
            const txStatus = await this.wrapper.contract.getTxIdStatus(scTxId);
            if(txStatus==="success") {
                this.state = LnForGasSwapState.FINISHED;
                this.scTxId = scTxId;

                await this.save();
                this.emitEvent();

                //Success
                return {
                    is_paid: true,
                    scTxId: scTxId
                }
            } else {
                return {
                    is_paid: false
                };
            }
        }

        if(jsonBody.code===10010 || jsonBody.code===10011 || jsonBody.code===10012) {
            //Yet unpaid
            return {
                is_paid: false
            };
        }

        throw new PaymentAuthError(jsonBody.msg,  jsonBody.code);
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<void> {
        if(this.state!==LnForGasSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        while(abortSignal==null || !abortSignal.aborted) {
            const result = await this.getInvoiceStatus(
                abortSignal
            );
            if(result.is_paid) return result as any;
            await timeoutPromise(checkIntervalSeconds || 5);
        }

        throw new AbortError();

    }

    /**
     * Returns current state of the swap
     */
    getState() {
        return this.state;
    }

    /**
     * @fires FromBTCLNWrapper#swapState
     * @fires FromBTCLNSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    getPaymentHash(): Buffer {
        const decodedPR = bolt11.decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        return this.pr;
    }

    getQrData(): string {
        return "lightning:"+this.pr.toUpperCase();
    }

    getType(): SwapType {
        return SwapType.FROM_BTCLN;
    }

    getTimeoutTime(): number {
        if(this.pr==null) return null;
        const decoded = bolt11.decode(this.pr);
        return (decoded.timeExpireDate*1000);
    }

    save(): Promise<void> {
        return this.wrapper.storage.saveData(this.getPaymentHash().toString("hex"), this);
    }

}