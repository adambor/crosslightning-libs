import {IStorageManager, StorageObject} from "crosslightning-base";
import {getLogger, LoggerType} from "../utils/Utils";

/**
 * StorageManager using browser's IndexedDB storage, also migrates the data from prior LocalStorage API, if that was
 *  used before for a given "storageKey"
 */
export class IndexedDBStorageManager<T extends StorageObject> implements IStorageManager<T> {

    protected readonly logger: LoggerType;

    storageKey: string;
    db: IDBDatabase;
    data: { [p: string]: T } = {};

    constructor(storageKey: string) {
        this.storageKey = storageKey;
        this.logger = getLogger("IndexedDBStorageManager("+this.storageKey+"): ");
    }

    private executeTransaction<T>(cbk: (tx: IDBObjectStore) => IDBRequest<T>, readonly: boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const tx = this.db.transaction("swaps", readonly ? "readonly" : "readwrite", {durability: "strict"});
            const req = cbk(tx.objectStore("swaps"));
            req.onsuccess = (event: any) => resolve(event.target.result);
            req.onerror = (event) => reject(event);
        });
    }

    private executeTransactionArr<T>(cbk: (tx: IDBObjectStore) => IDBRequest<T>[], readonly: boolean): Promise<T[]> {
        const tx = this.db.transaction("swaps", readonly ? "readonly" : "readwrite", {durability: "strict"});
        const reqs = cbk(tx.objectStore("swaps"));
        return Promise.all(reqs.map(req => new Promise<T>((resolve, reject) => {
            req.onsuccess = (event: any) => resolve(event.target.result);
            req.onerror = (event) => reject(event);
        })));
    }

    /**
     * Tries to migrate old LocalStorage API stored objects (if they exist) to the IndexedDB
     *
     * @private
     */
    private async tryMigrate(): Promise<boolean> {
        const txt = window.localStorage.getItem(this.storageKey);
        if(txt==null) return false;

        let data: {[key: string]: any};
        try {
            data = JSON.parse(txt);
        } catch (e) {
            this.logger.error("tryMigrate(): Tried to migrate the database, but cannot parse old local storage!");
            return false;
        }

        await this.executeTransactionArr<IDBValidKey>(store => Object.keys(data).map(id => {
            return store.put({id, data: data[id]});
        }), false);
        window.localStorage.removeItem(this.storageKey);

        this.logger.info("tryMigrate(): Database successfully migrated from localStorage to indexedDB!");

        return true;
    }

    async init(): Promise<void> {
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

    async loadData(type: { new(data: any): T }): Promise<T[]> {
        await this.tryMigrate();

        const result = await this.executeTransaction<{id: string, data: any}[]>(store => store.getAll(), true);

        const returnObj = [];
        result.forEach(data => {
            const deserialized = new type(data.data);
            this.data[data.id] = deserialized;
            returnObj.push(deserialized);
        });

        return returnObj;
    }

    async removeData(hash: string): Promise<void> {
        await this.executeTransaction<undefined>(store => store.delete(hash), false)
            .catch(() => null);
        if(this.data[hash]!=null) delete this.data[hash];
    }

    async removeDataArr(arr: string[]): Promise<void> {
        await this.executeTransactionArr<IDBValidKey>(store => arr.map(id => {
            return store.delete(id);
        }), false);
        arr.forEach(id => {
            if(this.data[id]!=null) delete this.data[id];
        })
    }

    async saveData(hash: string, object: T): Promise<void> {
        await this.executeTransaction<IDBValidKey>(store => store.put({
            id: hash,
            data: object.serialize()
        }), false);
        this.data[hash] = object;
    }

    async saveDataArr(arr: {id: string, object: T}[]): Promise<void> {
        await this.executeTransactionArr<IDBValidKey>(store => arr.map(data => {
            return store.put({id: data.id, data: data.object.serialize()});
        }), false);
        arr.forEach(data => {
            this.data[data.id] = data.object;
        })
    }

}