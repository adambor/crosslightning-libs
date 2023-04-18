import {ChainSwapType} from "./ChainSwapType";
import * as BN from "bn.js";
import {TokenAddress} from "./TokenAddress";
import {StorageObject} from "../storage/StorageObject";

export abstract class SwapData implements StorageObject {

    static deserializers: {
        [type: string]: new (serialized: any) => any,
    } = {};

    static deserialize<T extends SwapData>(data: any): T {
        if(SwapData.deserializers[data.type]!=null) {
            return new SwapData.deserializers[data.type](data) as unknown as T;
        }
    }

    abstract getOfferer(): string;
    abstract setOfferer(newOfferer: string);

    abstract getClaimer(): string;
    abstract setClaimer(newClaimer: string);

    abstract serialize(): any;

    abstract getType(): ChainSwapType;

    abstract getAmount(): BN;

    abstract getToken(): TokenAddress;

    abstract isToken(token: TokenAddress): boolean;

    abstract getExpiry(): BN;

    abstract getConfirmations(): number;

    abstract getEscrowNonce(): BN;

    abstract isPayOut(): boolean;

    abstract isPayIn(): boolean;

    abstract getHash(): string;

    abstract getTxoHash(): string;

}

