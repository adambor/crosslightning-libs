import {IWrapperStorage} from "./IWrapperStorage";
import {ISwap} from "../swaps/ISwap";

export class LocalWrapperStorage implements IWrapperStorage{

    storageKey: string;

    data: {
        [paymentHash: string]: any
    } = null;

    constructor(storageKey: string) {
        this.storageKey = storageKey;
    }

    loadIfNeeded(): void {
        if(this.data==null) {
            const completedTxt = window.localStorage.getItem(this.storageKey);
            if(completedTxt!=null) {
                this.data = JSON.parse(completedTxt);
                if(this.data==null) this.data = {};
            } else {
                this.data = {};
            }
        }
    }

    removeSwapData(swap: ISwap): Promise<boolean> {
        this.loadIfNeeded();

        const paymentHash = swap.getPaymentHash().toString("hex");
        if(this.data[paymentHash]!=null) {
            delete this.data[paymentHash];

            return this.save().then(() => true);
        }
        return Promise.resolve(false);
    }

    saveSwapData(swap: ISwap): Promise<void> {
        this.loadIfNeeded();

        const paymentHash = swap.getPaymentHash().toString("hex");
        this.data[paymentHash] = swap.serialize();

        return this.save();
    }

    saveSwapDataArr(swapData: ISwap[]): Promise<void> {
        this.loadIfNeeded();

        for(let swap of swapData) {
            const paymentHash = swap.getPaymentHash().toString("hex");
            this.data[paymentHash] = swap.serialize();
        }

        return this.save();
    }

    loadSwapData<T extends ISwap>(wrapper: any, type: new(wrapper: any, data: any) => T): Promise<{
        [paymentHash: string]: T
    }> {
        this.loadIfNeeded();

        const returnObj = {};

        Object.keys(this.data).forEach(paymentHash => {
            returnObj[paymentHash] = new type(wrapper, this.data[paymentHash]);
        });

        return Promise.resolve(returnObj);
    }

    save(): Promise<void> {
        this.loadIfNeeded();
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        return Promise.resolve();
    }
}