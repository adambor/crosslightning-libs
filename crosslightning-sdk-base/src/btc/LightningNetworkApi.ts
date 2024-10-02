import * as BN from "bn.js";

export type LNNodeLiquidity = {
    publicKey: string,
    capacity: BN,
    numChannels: number
};

export interface LightningNetworkApi {

    /**
     * Returns the lightning network's node liquidity as identified by an identity public key
     * @param pubkey
     */
    getLNNodeLiquidity(pubkey: string): Promise<LNNodeLiquidity>

}