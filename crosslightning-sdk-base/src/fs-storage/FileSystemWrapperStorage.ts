import {IWrapperStorage} from "../storage/IWrapperStorage";
import {ISwap} from "../swaps/ISwap";
import * as fs from "fs/promises";

export class FileSystemWrapperStorage implements IWrapperStorage{

    private readonly directory: string;
    data: {
        [paymentHash: string]: any
    } = {};

    constructor(directory: string) {
        this.directory = directory;
    }

    async loadIfNeeded(): Promise<void> {
        try {
            await fs.mkdir(this.directory)
        } catch (e) {}
    }

    async removeSwapData(swap: ISwap): Promise<boolean> {
        await this.loadIfNeeded();

        const paymentHash = swap.getPaymentHash().toString("hex");
        try {
            if(this.data[paymentHash]!=null) delete this.data[paymentHash];
            await fs.rm(this.directory+"/"+paymentHash+".json");
        } catch (e) {
            console.error(e);
            return false;
        }

        return true;
    }

    async saveSwapData(swap: ISwap): Promise<void> {
        await this.loadIfNeeded();

        const paymentHash = swap.getPaymentHash().toString("hex");;
        const serialized = swap.serialize();
        this.data[paymentHash] = serialized;
        await fs.writeFile(this.directory+"/"+paymentHash+".json", JSON.stringify(serialized));
    }

    async saveSwapDataArr(swapData: ISwap[]): Promise<void> {
        await this.loadIfNeeded();

        for(let swap of swapData) {
            const paymentHash = swap.getPaymentHash().toString("hex");
            const serialized = swap.serialize();
            this.data[paymentHash] = serialized;
            await fs.writeFile(this.directory+"/"+paymentHash+".json", JSON.stringify(serialized));
        }
    }

    async loadSwapData<T extends ISwap>(wrapper: any, type: new(wrapper: any, data: any) => T): Promise<{
        [paymentHash: string]: T
    }> {
        await this.loadIfNeeded();

        let files;
        try {
            files = await fs.readdir(this.directory);
        } catch (e) {
            console.error(e);
            return {};
        }

        const returnObj = {};

        for(let file of files) {
            const paymentHash = file.split(".")[0];
            const result = await fs.readFile(this.directory+"/"+file);
            const obj = JSON.parse(result.toString());
            const parsed = new type(wrapper, obj);
            this.data[paymentHash] = parsed;
            returnObj[paymentHash] = parsed;
        }

        return returnObj;
    }

}