import BN from "bn.js";
import {TokenAddress} from "./TokenAddress";
import {StorageObject} from "../storage/StorageObject";

export abstract class SameChainSwapData implements StorageObject {

    static deserializers: {
        [type: string]: new (serialized: any) => any,
    } = {};

    static deserialize<T extends SameChainSwapData>(data: any): T {
        if(SameChainSwapData.deserializers[data.type]!=null) {
            return new SameChainSwapData.deserializers[data.type](data) as unknown as T;
        }
    }

    abstract getOfferer(): string;
    abstract setOfferer(newOfferer: string);

    abstract getClaimer(): string;
    abstract setClaimer(newClaimer: string);

    abstract serialize(): any;

    abstract getOffererAmount(): BN;
    abstract getOffererToken(): TokenAddress;
    abstract isOffererToken(token: TokenAddress): boolean;

    abstract getClaimerAmount(): BN;
    abstract getClaimerToken(): TokenAddress;
    abstract isClaimerToken(token: TokenAddress): boolean;

    abstract getExpiry(): BN;

    abstract isPayIn(): boolean;
    abstract isPayOut(): boolean;

    abstract getHash(): string;

    abstract equals(other: SameChainSwapData): boolean;

}

