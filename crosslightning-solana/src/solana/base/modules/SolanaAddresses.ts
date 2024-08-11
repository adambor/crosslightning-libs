import {SolanaModule} from "../SolanaModule";
import {PublicKey} from "@solana/web3.js";


export class SolanaAddresses extends SolanaModule {

    ///////////////////
    //// Address utils
    getAddress(): string {
        return this.provider.publicKey.toBase58();
    }

    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

}