import {StorageObject} from "crosslightning-base";

export type StorageQueryParam = {
    key: string,
    value: any
}

export interface IIntermediaryStorage<T extends StorageObject> {

    init(): Promise<void>;

    query(params: StorageQueryParam[]): Promise<T[]>;

    getData(hash: string): Promise<T>;
    saveData(hash: string, object: T): Promise<void>;
    removeData(hash: string): Promise<void>;
    loadData(type: new(data: any) => T): Promise<void>;

}