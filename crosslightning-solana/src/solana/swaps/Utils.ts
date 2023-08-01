import {BorshCoder} from "@coral-xyz/anchor";
import {Message, PublicKey, Transaction} from "@solana/web3.js";
import {programIdl} from "./programIdl";

const coder = new BorshCoder(programIdl);

const programPubKey = new PublicKey(programIdl.metadata.address);

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

class Utils {

    static decodeInstructions(transactionMessage: Message): {
        name: string,
        data: {
            [key: string]: any
        },
        accounts: {
            [key: string]: PublicKey
        }
    }[] {

        const instructions = [];

        for(let ix of transactionMessage.instructions) {
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(programPubKey)) {
                const parsedIx: any = coder.instruction.decode(ix.data, 'base58') as any;
                const accountsData = nameMappedInstructions[parsedIx.name];
                if(accountsData!=null && accountsData.accounts!=null) {
                    parsedIx.accounts = {};
                    for(let i=0;i<accountsData.accounts.length;i++) {
                        parsedIx.accounts[accountsData.accounts[i].name] = transactionMessage.accountKeys[ix.accounts[i]]
                    }
                }
                instructions.push(parsedIx);
            } else {
                instructions.push(null);
            }
        }

        return instructions;

    }

    /**
     * @param tx a solana transaction
     * @param feePayer the publicKey of the signer
     * @returns size in bytes of the transaction
     */
    static getTxSize(tx: Transaction, feePayer: PublicKey): number {
        const feePayerPk = [feePayer.toBase58()];

        const signers = new Set<string>(feePayerPk);
        const accounts = new Set<string>(feePayerPk);

        const ixsSize = tx.instructions.reduce((acc, ix) => {
            ix.keys.forEach(({ pubkey, isSigner }) => {
                const pk = pubkey.toBase58();
                if (isSigner) signers.add(pk);
                accounts.add(pk);
            });

            accounts.add(ix.programId.toBase58());

            const nIndexes = ix.keys.length;
            const opaqueData = ix.data.length;

            return (
                acc +
                1 + // PID index
                Utils.compactArraySize(nIndexes, 1) +
                Utils.compactArraySize(opaqueData, 1)
            );
        }, 0);

        return (
            Utils.compactArraySize(signers.size, 64) + // signatures
            3 + // header
            Utils.compactArraySize(accounts.size, 32) + // accounts
            32 + // blockhash
            Utils.compactHeader(tx.instructions.length) + // instructions
            ixsSize
        );
    };

    // COMPACT ARRAY

    static LOW_VALUE = 127; // 0x7f
    static HIGH_VALUE = 16383; // 0x3fff

    /**
     * Compact u16 array header size
     * @param n elements in the compact array
     * @returns size in bytes of array header
     */
    static compactHeader(n: number): number {
        return (n <= Utils.LOW_VALUE ? 1 : n <= Utils.HIGH_VALUE ? 2 : 3);
    }

    /**
     * Compact u16 array size
     * @param n elements in the compact array
     * @param size bytes per each element
     * @returns size in bytes of array
     */
    static compactArraySize(n: number, size: number): number {
        return Utils.compactHeader(n) + n * size;
    }

}

export default Utils;