import {Lockable, StorageObject, SwapData} from "crosslightning-base";
import {SwapHandlerType} from "./SwapHandler";

export class SwapHandlerSwap<T extends SwapData> extends Lockable implements StorageObject {

    type: SwapHandlerType;
    data: T;

    constructor();
    constructor(obj: any);

    constructor(obj?: any) {
        super();
        if(obj!=null) {
            this.data = obj.data==null ? null : SwapData.deserialize(obj.data);
        }
    }

    serialize(): any {
        return {
            data: this.data==null ? null : this.data.serialize()
        }
    }

}