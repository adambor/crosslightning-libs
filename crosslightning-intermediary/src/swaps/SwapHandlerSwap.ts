import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerType} from "./SwapHandler";

export class SwapHandlerSwap<T extends SwapData> extends Lockable implements StorageObject {

    type: SwapHandlerType;
    data: T;
    metadata: {
        request: any,
        times: {[key: string]: number},
        [key: string]: any
    };

    constructor();
    constructor(obj: any);

    constructor(obj?: any) {
        super();
        if(obj!=null) {
            this.data = obj.data==null ? null : SwapData.deserialize(obj.data);
            this.metadata = obj.metadata;
        }
    }

    serialize(): any {
        return {
            data: this.data==null ? null : this.data.serialize(),
            metadata: this.metadata
        }
    }

}