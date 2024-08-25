import {StorageObject} from "crosslightning-base";
import * as fs from "fs/promises";
import {IIntermediaryStorage, StorageQueryParam} from "../storage/IIntermediaryStorage";
import * as BN from "bn.js";

export class IntermediaryStorageManager<T extends StorageObject> implements IIntermediaryStorage<T> {

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
                if(param.value!=null) {
                    if(typeof param.value === "object") {
                        if(param.value.eq!=null && !param.value.eq(val[param.key])) return false;
                        if(param.value.equals!=null && !param.value.equals(val[param.key])) return false;
                    } else {
                        if(param.value!==val[param.key]) return false;
                    }
                } else if(param.values!=null) {
                    let hasSome = false;
                    for(let expectedValue of param.values) {
                        if(typeof expectedValue === "object") {
                            if(expectedValue.eq!=null && !expectedValue.eq(val[param.key])) hasSome = true;
                            if(expectedValue.equals!=null && !expectedValue.equals(val[param.key])) hasSome = true;
                        } else {
                            if(expectedValue===val[param.key]) hasSome = true;
                        }
                    }
                    if(!hasSome) return false;
                }
            }
            return true;
        }));
    }

    getData(paymentHash: string, sequence: BN | null): Promise<T> {
        return Promise.resolve(this.data[paymentHash+"_"+(sequence || new BN(0)).toString("hex", 8)]);
    }

    async saveData(hash: string, sequence: BN | null, object: T): Promise<void> {

        const _sequence = (sequence || new BN(0)).toString("hex", 8);

        try {
            await fs.mkdir(this.directory)
        } catch (e) {}

        this.data[hash+"_"+_sequence] = object;

        const cpy = object.serialize();

        await fs.writeFile(this.directory+"/"+hash+"_"+_sequence+".json", JSON.stringify(cpy));

    }

    async removeData(hash: string, sequence: BN | null): Promise<void> {
        const identifier = hash+"_"+(sequence || new BN(0)).toString("hex", 8);
        try {
            if(this.data[identifier]!=null) delete this.data[identifier];
            await fs.rm(this.directory+"/"+identifier+".json");
        } catch (e) {
            console.error(e);
        }
    }

    async loadData(type: new(data: any) => T): Promise<void> {
        this.type = type;

        let files: string[];
        try {
            files = await fs.readdir(this.directory);
        } catch (e) {
            console.error(e);
            return;
        }

        for(let file of files) {
            const indentifier = file.split(".")[0];
            const result = await fs.readFile(this.directory+"/"+file);
            const obj = JSON.parse(result.toString());
            const parsed = new type(obj);
            this.data[indentifier] = parsed;
        }
    }

}
