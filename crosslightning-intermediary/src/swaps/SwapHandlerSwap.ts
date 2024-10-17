import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerType} from "./SwapHandler";
import {PluginManager} from "../plugins/PluginManager";
import * as BN from "bn.js";
import {deserializeBN, serializeBN} from "../utils/Utils";

export abstract class SwapHandlerSwap<T extends SwapData = SwapData, S = any> extends Lockable implements StorageObject {

    chainIdentifier: string;
    state: S;

    type: SwapHandlerType;
    data: T;
    metadata: {
        request: any,
        times: {[key: string]: number},
        [key: string]: any
    };
    txIds: {
        init?: string,
        claim?: string,
        refund?: string
    } = {};
    readonly swapFee: BN;
    readonly swapFeeInToken: BN;

    protected constructor(chainIdentifier: string, swapFee: BN, swapFeeInToken: BN);
    protected constructor(obj: any);

    protected constructor(obj?: any | string, swapFee?: BN, swapFeeInToken?: BN) {
        super();
        if(typeof(obj)==="string" && BN.isBN(swapFee) && BN.isBN(swapFeeInToken)) {
            this.chainIdentifier = obj;
            this.swapFee = swapFee;
            this.swapFeeInToken = swapFeeInToken;
            return;
        } else {
            this.data = obj.data==null ? null : SwapData.deserialize(obj.data);
            this.metadata = obj.metadata;
            this.chainIdentifier = obj.chainIdentifier;
            this.txIds = obj.txIds || {};
            this.state = obj.state;
            this.swapFee = deserializeBN(obj.swapFee);
            this.swapFeeInToken = deserializeBN(obj.swapFeeInToken);
        }
    }

    serialize(): any {
        return {
            state: this.state,
            data: this.data==null ? null : this.data.serialize(),
            chainIdentifier: this.chainIdentifier,
            metadata: this.metadata,
            txIds: this.txIds,
            swapFee: serializeBN(this.swapFee),
            swapFeeInToken: serializeBN(this.swapFeeInToken)
        }
    }

    /**
     * Sets the state of the swap and also calls swap change listener on plugins
     *
     * @param newState
     */
    setState(newState: S): Promise<void> {
        const oldState = this.state;
        this.state = newState;
        return PluginManager.swapStateChange(this, oldState);
    }

    getHash(): string {
        return this.data.getHash();
    }

    getSequence(): BN {
        return this.data.getSequence();
    }

    /**
     * Returns unique identifier of the swap in the form <hash>_<sequence> or just <hash> if the swap type doesn't
     *  use sequence number
     */
    getIdentifier(): string {
        if(this.getSequence()!=null) {
            return this.chainIdentifier+"_"+this.getHash()+"_"+this.getSequence().toString(16);
        }
        return this.getHash();
    }

    /**
     * Checks whether the swap is finished, such that it is final and either successful or failed
     */
    isFinished(): boolean {
        return this.isSuccess() || this.isFailed();
    }

    /**
     * Checks whether the swap was initiated by the user
     */
    abstract isInitiated(): boolean;

    /**
     * Checks whether the swap was finished and was successful
     */
    abstract isSuccess(): boolean;

    /**
     * Checks whether the swap was finished and was failed
     */
    abstract isFailed(): boolean;

    /**
     * Returns the input amount paid by the user (excluding fees)
     */
    abstract getInputAmount(): BN;

    /**
     * Returns the total input amount paid by the user (including all fees)
     */
    abstract getTotalInputAmount(): BN;

    /**
     * Returns the actual output amount paid out to the user
     */
    abstract getOutputAmount(): BN;

    /**
     * Returns swap fee, denominated in input & output tokens (the fee is paid only once, it is just represented here in
     *  both denomination for ease of use)
     */
    abstract getSwapFee(): {inInputToken: BN, inOutputToken: BN};

}