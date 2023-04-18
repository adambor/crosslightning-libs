import {ISwap} from "../swaps/ISwap";

export interface IWrapperStorage {

    removeSwapData(swapData: ISwap): Promise<boolean>;

    saveSwapData(swapData: ISwap): Promise<void>;
    saveSwapDataArr(swapData: ISwap[]): Promise<void>;

    loadSwapData<T extends ISwap>(wrapper: any, type: new(wrapper: any, data: any) => T): Promise<{
        [paymentHash: string]: T
    }>;

}