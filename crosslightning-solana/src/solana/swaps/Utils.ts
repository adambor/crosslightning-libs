import {BorshCoder, DecodeType, Event, IdlTypes} from "@coral-xyz/anchor";
import {IdlField} from "@coral-xyz/anchor/dist/cjs/idl";
import {Message, ParsedMessage, PartiallyDecodedInstruction, PublicKey, Transaction} from "@solana/web3.js";
import * as programIdl from "./programIdl.json";
import {SwapProgram} from "./programTypes";

const coder = new BorshCoder(programIdl as any);
const programPubKey = new PublicKey(programIdl.metadata.address);
const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

class Utils {

    static decodeInstructions(transactionMessage: ParsedMessage): IxWithAccounts[] {
        const instructions: IxWithAccounts[] = [];

        for(let _ix of transactionMessage.instructions) {
            if(!_ix.programId.equals(programPubKey)) {
                instructions.push(null);
                continue;
            }

            const ix: PartiallyDecodedInstruction = _ix as PartiallyDecodedInstruction;
            if(ix.data==null) continue;

            const parsedIx: any = coder.instruction.decode(ix.data, 'base58');
            const accountsData = nameMappedInstructions[parsedIx.name];
            if(accountsData!=null && accountsData.accounts!=null) {
                parsedIx.accounts = {};
                for(let i=0;i<accountsData.accounts.length;i++) {
                    parsedIx.accounts[accountsData.accounts[i].name] = ix.accounts[i];
                }
            }
            instructions.push(parsedIx);
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

export function onceAsync<T>(executor: () => Promise<T>): () => Promise<T> {
    let promise: Promise<T>;

    return () => {
        if(promise==null) {
            promise = executor();
            return promise;
        } else {
            return promise.catch(() => promise = executor());
        }
    }
}

export function getLogger(prefix: string) {
    return {
        debug: (msg, ...args) => console.debug(prefix+msg, ...args),
        info: (msg, ...args) => console.info(prefix+msg, ...args),
        warn: (msg, ...args) => console.warn(prefix+msg, ...args),
        error: (msg, ...args) => console.error(prefix+msg, ...args)
    };
}

export default Utils;