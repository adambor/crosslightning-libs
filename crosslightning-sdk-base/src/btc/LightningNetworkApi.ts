import * as BN from "bn.js";

export type LNNodeLiquidity = {
    publicKey: string,
    capacity: BN,
    numChannels: number
};

export interface LightningNetworkApi {

    getLNNodeLiquidity(pubkey: string): Promise<LNNodeLiquidity>

}