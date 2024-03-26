import {IWrapperStorage} from "./IWrapperStorage";
import {ISwap} from "../swaps/ISwap";

export class IndexedDBWrapperStorage implements IWrapperStorage{

    storageKey: string;
    db: IDBDatabase;

    constructor(storageKey: string) {
        this.storageKey = storageKey;
    }

    executeTransaction<T>(cbk: (tx: IDBObjectStore) => IDBRequest<T>, readonly: boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const tx = this.db.transaction("swaps", readonly ? "readonly" : "readwrite", {durability: "strict"});
            const req = cbk(tx.objectStore("swaps"));
            req.onsuccess = (event: any) => resolve(event.target.result);
            req.onerror = (event) => reject(event);
        });
    }

    executeTransactionArr<T>(cbk: (tx: IDBObjectStore) => IDBRequest<T>[], readonly: boolean): Promise<T[]> {
        const tx = this.db.transaction("swaps", readonly ? "readonly" : "readwrite", {durability: "strict"});
        const reqs = cbk(tx.objectStore("swaps"));
        return Promise.all(reqs.map(req => new Promise<T>((resolve, reject) => {
            req.onsuccess = (event: any) => resolve(event.target.result);
            req.onerror = (event) => reject(event);
        })));
    }

    async tryMigrate(): Promise<boolean> {
        await this.loadIfNeeded();

        const txt = window.localStorage.getItem(this.storageKey);
        if(txt==null) return false;

        let data: {[key: string]: any};
        try {
            data = JSON.parse(txt);
        } catch (e) {
            console.error(e);
            return false;
        }

        await this.executeTransactionArr<IDBValidKey>(store => Object.keys(data).map(id => {
            return store.put({id, data: data[id]});
        }), false);

        window.localStorage.removeItem(this.storageKey);

        return true;
    }


    async loadIfNeeded(): Promise<void> {
        if(this.db==null) {
            this.db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = window.indexedDB.open(this.storageKey, 1);
                request.onupgradeneeded = (event: any) => {
                    const db: IDBDatabase = event.target.result;
                    db.createObjectStore("swaps", { keyPath: "id" });
                };
                request.onerror = (e) => reject(e);
                request.onsuccess = (e: any) => resolve(e.target.result);
            });
        }
    }

    async removeSwapData(swap: ISwap): Promise<boolean> {
        await this.loadIfNeeded();

        const id = swap.getPaymentHash().toString("hex");

        return await this.executeTransaction<undefined>(store => store.delete(id), false)
            .then(() => true)
            .catch(() => false);
    }

    async saveSwapData(swap: ISwap): Promise<void> {
        await this.loadIfNeeded();

        const id = swap.getPaymentHash().toString("hex");
        await this.executeTransaction<IDBValidKey>(store => store.put({
            id,
            data: swap.serialize()
        }), false);
    }

    async saveSwapDataArr(swapData: ISwap[]): Promise<void> {
        await this.loadIfNeeded();

        await this.executeTransactionArr<IDBValidKey>(store => swapData.map(swap => {
            const id = swap.getPaymentHash().toString("hex");
            return store.put({id, data: swap.serialize()});
        }), false);
    }

    async loadSwapData<T extends ISwap>(wrapper: any, type: new(wrapper: any, data: any) => T): Promise<{
        [paymentHash: string]: T
    }> {
        await this.loadIfNeeded();
        await this.tryMigrate();

        const result = await this.executeTransaction<{id: string, data: any}[]>(store => store.getAll(), true);

        const returnObj = {};
        result.forEach(data => {
            returnObj[data.id] = new type(wrapper, data.data);
        });

        return returnObj;
    }

}