import {Lockable, StorageObject, SwapData} from "crosslightning-base";

export class SwapHandlerSwap<T extends SwapData> extends Lockable implements StorageObject {

    data: T;

    constructor();
    constructor(obj: any);

    constructor(obj?: any) {
        super();
        if(obj!=null) {
            this.data = obj.data==null ? null : SwapData.deserialize(obj);
        }
    }

    serialize(): any {
        return {
            data: this.data==null ? null : this.data.serialize()
        }
    }

}