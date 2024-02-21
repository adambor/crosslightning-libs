import {IStorageManager, StorageObject} from "crosslightning-base";

export class LocalStorageManager<T extends StorageObject> implements IStorageManager<T> {

    storageKey: string;

    data: {
        [hash: string]: any
    } = null;

    constructor(storageKey: string) {
        this.storageKey = storageKey;
    }

    init(): Promise<void> {
        const completedTxt = window.localStorage.getItem(this.storageKey);
        if(completedTxt!=null) {
            this.data = JSON.parse(completedTxt);
            if(this.data==null) this.data = {};
        } else {
            this.data = {};
        }
        return Promise.resolve();
    }

    saveData(hash: string, object: T): Promise<void> {
        this.data[hash] = object.serialize();

        return this.save();
    }

    removeData(hash: string): Promise<void> {
        if(this.data[hash]!=null) {
            delete this.data[hash];
            return this.save();
        }
        return Promise.resolve();
    }

    loadData(type: new (data: any) => T): Promise<T[]> {
        return Promise.resolve(
            Object.keys(this.data).map(e => new type(this.data[e]))
        );
    }

    save(): Promise<void> {
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        return Promise.resolve();
    }
}