import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerType} from "./SwapHandler";
import {PluginManager} from "../plugins/PluginManager";
import * as BN from "bn.js";

export class SwapHandlerSwap<T extends SwapData, S = any> extends Lockable implements StorageObject {

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

    constructor();
    constructor(obj: any);

    constructor(obj?: any) {
        super();
        if(obj!=null) {
            this.data = obj.data==null ? null : SwapData.deserialize(obj.data);
            this.metadata = obj.metadata;
            this.txIds = obj.txIds || {};
            this.state = obj.state;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            data: this.data==null ? null : this.data.serialize(),
            metadata: this.metadata,
            txIds: this.txIds
        }
    }

    async setState(newState: S): Promise<void> {
        const oldState = this.state;
        this.state = newState;
        await PluginManager.swapStateChange(this, oldState);
    }

    getHash(): string {
        return this.data.getHash();
    }

    getSequence(): BN {
        return this.data.getSequence();
    }

    getIdentifier(): string {
        if(this.getSequence()!=null) {
            return this.getHash()+"_"+this.getSequence().toString(16);
        }
        return this.getHash();
    }

}