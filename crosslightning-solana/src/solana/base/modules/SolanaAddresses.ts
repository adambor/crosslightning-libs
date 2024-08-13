import {SolanaModule} from "../SolanaModule";
import {PublicKey} from "@solana/web3.js";


export class SolanaAddresses extends SolanaModule {

    ///////////////////
    //// Address utils
    /**
     * Returns address of the underlying anchor provider
     */
    getAddress(): string {
        return this.provider.publicKey.toBase58();
    }

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