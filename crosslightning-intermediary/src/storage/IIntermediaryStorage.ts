import {StorageObject} from "crosslightning-base";
import * as BN from "bn.js";

export type StorageQueryParam = {
    key: string,
    value?: any,
    values?: any[]
}

export interface IIntermediaryStorage<T extends StorageObject> {

    init(): Promise<void>;

    query(params: StorageQueryParam[]): Promise<T[]>;

    getData(hash: string, sequence: BN | null): Promise<T>;
    saveData(hash: string, sequence: BN | null, object: T): Promise<void>;
    removeData(hash: string, sequence: BN | null): Promise<void>;
    loadData(type: new(data: any) => T): Promise<void>;

}