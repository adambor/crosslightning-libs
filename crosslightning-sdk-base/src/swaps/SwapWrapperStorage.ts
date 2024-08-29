import {ISwap} from "./ISwap";
import {IStorageManager} from "crosslightning-base";

export class SwapWrapperStorage<T extends ISwap> {

    storage: IStorageManager<T>;

    constructor(storage: IStorageManager<T>) {
        this.storage = storage;
    }

    init(): Promise<void> {
        return this.storage.init();
    }

    async removeSwapData(swapData: T): Promise<boolean> {
        const id = swapData.getPaymentHash().toString("hex");
        if(this.storage.data[id]==null) return false;
        await this.storage.removeData(id);
        return true;
    }

    saveSwapData(swapData: T): Promise<void> {
        const id = swapData.getPaymentHash().toString("hex");
        return this.storage.saveData(id, swapData);
    }

    async saveSwapDataArr(arr: T[]): Promise<void> {
        if((this.storage as any).saveDataArr!=null) {
            await (this.storage as any).saveDataArr(arr.map(swap => {
                return {id: swap.getPaymentHash().toString("hex"), object: swap.serialize()}
            }));
            return;
        }

        for(let swapData of arr) {
            const id = swapData.getPaymentHash().toString("hex");
            await this.storage.saveData(id, swapData);
        }
    }

    async loadSwapData(wrapper: any, type: new(wrapper: any, data: any) => T): Promise<{
        [paymentHash: string]: T
    }> {
        const res = await this.storage.loadData(type.bind(null, wrapper));
        const obj: {
            [paymentHash: string]: T
        } = {};
        res.forEach(swap => obj[swap.getPaymentHash().toString("hex")] = swap);
        return obj;
    }

}