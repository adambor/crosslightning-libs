import { Wallet } from "@coral-xyz/anchor/dist/cjs/provider";
import {AbstractSigner} from "crosslightning-base";
import {PublicKey, Signer} from "@solana/web3.js";

export class SolanaSigner implements AbstractSigner {

    wallet: Wallet;
    keypair?: Signer;

    constructor(wallet: Wallet, keypair?: Signer) {
        this.wallet = wallet;
        this.keypair = keypair;
    }

    getPublicKey(): PublicKey {
        return this.wallet.publicKey;
    }

    getAddress(): string {
        return this.wallet.publicKey.toString();
    }

}
