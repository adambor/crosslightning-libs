import {SwapType} from "../swaps/SwapType";
import {SwapHandlerInfoType} from "./IntermediaryDiscovery";
import * as BN from "bn.js";
import {ChainSwapType} from "crosslightning-base";

export type ServicesType = {
    [key in SwapType]?: SwapHandlerInfoType
};

export type ReputationType = {
    [token: string]: {
        [key in ChainSwapType]: {
            successVolume: BN,
            successCount: BN,
            failVolume: BN,
            failCount: BN,
            coopCloseVolume: BN,
            coopCloseCount: BN,
        }
    }
};

export class Intermediary {

    readonly url: string;
    readonly address: string;
    readonly services: ServicesType;
    readonly reputation: ReputationType;

    constructor(url: string, address: string, services: ServicesType, reputation: ReputationType) {
        this.url = url;
        this.address = address;
        this.services = services;
        this.reputation = reputation;
    }

}
