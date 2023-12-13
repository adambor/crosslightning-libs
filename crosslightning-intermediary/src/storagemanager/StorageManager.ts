import {StorageObject} from "crosslightning-base";
import * as fs from "fs/promises";
import {IIntermediaryStorage, StorageQueryParam} from "../storage/IIntermediaryStorage";

export class StorageManager<T extends StorageObject> implements IIntermediaryStorage<T> {

    private readonly directory: string;
    private type: new(data: any) => T;
    private data: {
        [key: string]: T
    } = {};

    constructor(directory: string) {
        this.directory = directory;
    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.directory)
        } catch (e) {}
    }

    query(params: StorageQueryParam[]): Promise<T[]> {
        return Promise.resolve(Object.keys(this.data).map((val) => this.data[val]).filter((val) => {
            for(let param of params) {
                if(typeof param.value === "object") {
                    if(param.value.eq!=null && !param.value.eq(val[param.key])) return false;
                    if(param.value.equals!=null && !param.value.equals(val[param.key])) return false;
                } else {
                    if(param.value!==val[param.key]) return false;
                }
            }
            return true;
        }));
    }

    getData(paymentHash: string): Promise<T> {
        return Promise.resolve(this.data[paymentHash]);
    }

    async saveData(hash: string, object: T): Promise<void> {

        try {
            await fs.mkdir(this.directory)
        } catch (e) {}

        this.data[hash] = object;

        const cpy = object.serialize();

        await fs.writeFile(this.directory+"/"+hash+".json", JSON.stringify(cpy));

    }

    async removeData(hash: string): Promise<void> {
        const paymentHash = hash;
        try {
            if(this.data[paymentHash]!=null) delete this.data[paymentHash];
            await fs.rm(this.directory+"/"+paymentHash+".json");
        } catch (e) {
            console.error(e);
        }
    }

    async loadData(type: new(data: any) => T): Promise<void> {
        this.type = type;
        let files;

        files = await fs.readdir(this.directory);

        for(let file of files) {
            const paymentHash = file.split(".")[0];
            const result = await fs.readFile(this.directory+"/"+file);
            const obj = JSON.parse(result.toString());
            const parsed = new type(obj);
            this.data[paymentHash] = parsed;
        }
    }

}
