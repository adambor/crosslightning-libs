import {PublicKey, Signer, Transaction, TransactionInstruction} from "@solana/web3.js";
import {SolanaTx} from "./modules/SolanaTransactions";
import {SolanaBase} from "./SolanaBase";


export class SolanaAction {

    computeBudget: number;
    private readonly root: SolanaBase;
    private readonly instructions: TransactionInstruction[];
    private feeRate: string;
    private readonly signers: Signer[];
    private firstIxBeforeComputeBudget: boolean = false;

    constructor(
        root: SolanaBase,
        instructions: TransactionInstruction[] | TransactionInstruction = [],
        computeBudget: number = 0,
        feeRate?: string,
        signers?: Signer[],
        firstIxBeforeComputeBudget?: boolean
    ) {
        this.root = root;
        this.instructions = Array.isArray(instructions) ? instructions : [instructions];
        this.computeBudget = computeBudget;
        this.feeRate = feeRate;
        this.signers = signers || [];
        if(firstIxBeforeComputeBudget!=null) this.firstIxBeforeComputeBudget = firstIxBeforeComputeBudget;
    }

    private estimateFee(): Promise<string> {
        const mutableAccounts: PublicKey[] = [];
        this.instructions.forEach(
            ix => ix.keys.forEach(
                key => key.isWritable && mutableAccounts.push(key.pubkey)
            )
        );
        return this.root.Fees.getFeeRate(mutableAccounts);
    }

    public addIx(instruction: TransactionInstruction, computeBudget?: number, signers?: Signer[]) {
        this.instructions.push(instruction);
        if(this.computeBudget==null) {
            this.computeBudget = computeBudget;
        } else {
            if(computeBudget!=null) this.computeBudget+=computeBudget;
        }
    }

    public add(action: SolanaAction): this {
        return this.addAction(action);
    }

    public addAction(action: SolanaAction, index: number = this.instructions.length): this {
        if(action.firstIxBeforeComputeBudget) {
            if(this.instructions.length>0)
                throw new Error("Tried to add firstIxBeforeComputeBudget action to existing action with instructions");
            this.firstIxBeforeComputeBudget = true;
        }
        if(this.firstIxBeforeComputeBudget && this.instructions.length>0 && index===0)
            throw new Error("Tried adding to firstIxBeforeComputeBudget action on 0th index");
        if(this.computeBudget==null && action.computeBudget!=null) this.computeBudget = action.computeBudget;
        if(this.computeBudget!=null && action.computeBudget!=null) this.computeBudget += action.computeBudget;
        this.instructions.splice(index, 0, ...action.instructions);
        this.signers.push(...action.signers);
        if(this.feeRate==null) this.feeRate = action.feeRate;
        return this;
    }

    public async tx(feeRate?: string, block?: {blockhash: string, blockHeight: number}): Promise<SolanaTx> {
        const tx = new Transaction();
        tx.feePayer = this.root.provider.publicKey;

        if(feeRate==null) feeRate = this.feeRate;
        if(feeRate==null) feeRate = await this.estimateFee();

        let instructions = this.instructions;
        if(instructions.length>0 && this.firstIxBeforeComputeBudget) {
            tx.add(this.instructions[0]);
            instructions = this.instructions.slice(1);
        }
        this.root.Fees.applyFeeRateBegin(tx, this.computeBudget, feeRate);
        instructions.forEach(ix => tx.add(ix));
        this.root.Fees.applyFeeRateEnd(tx, this.computeBudget, feeRate);

        if(block!=null) {
            tx.recentBlockhash = block.blockhash;
            tx.lastValidBlockHeight = block.blockHeight + this.root.TX_SLOT_VALIDITY;
        }

        return {
            tx,
            signers: this.signers
        };
    }

    public async addToTxs(txs: SolanaTx[], feeRate?: string, block?: {blockhash: string, blockHeight: number}): Promise<void> {
        txs.push(await this.tx(feeRate, block));
    }

}