import {Wallet} from "@coral-xyz/anchor/dist/cjs/provider";
import {Keypair, PublicKey, Transaction, VersionedTransaction} from "@solana/web3.js";

export class KeypairWallet implements Wallet {

    readonly payer: Keypair;

    constructor(payer: Keypair) {
        this.payer = payer;
    }

    get publicKey(): PublicKey {
        return this.payer.publicKey;
    }

    signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
        txs.forEach((tx) => {
            if(tx instanceof Transaction) {
                tx.partialSign(this.payer);
            } else if(tx instanceof VersionedTransaction) {
                tx.sign([this.payer]);
            }
        });
        return Promise.resolve(txs);
    }

    signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
        if(tx instanceof Transaction) {
            tx.partialSign(this.payer);
        } else if(tx instanceof VersionedTransaction) {
            tx.sign([this.payer]);
        }
        return Promise.resolve(tx);
    }

}
