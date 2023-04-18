import {BorshCoder} from "@coral-xyz/anchor";
import {Message, PublicKey} from "@solana/web3.js";
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

}

export default Utils;