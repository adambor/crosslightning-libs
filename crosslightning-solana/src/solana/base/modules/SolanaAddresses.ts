import {SolanaModule} from "../SolanaModule";
import {PublicKey} from "@solana/web3.js";


export class SolanaAddresses extends SolanaModule {

    ///////////////////
    //// Address utils
    /**
     * Checks whether an address is a valid Solana address (base58 encoded ed25519 public key)
     *
     * @param address
     */
    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

}