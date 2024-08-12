import {PublicKey, Signer, Transaction, TransactionInstruction} from "@solana/web3.js";
import {SolanaTx} from "./modules/SolanaTransactions";
import {AnchorProvider} from "@coral-xyz/anchor";
import {SolanaFees} from "./modules/SolanaFees";
import {SolanaBase} from "./SolanaBase";


export class SolanaAction {

    readonly computeBudget: number;
    private readonly root: SolanaBase;
    private readonly instructions: TransactionInstruction[];
    private readonly feeRate: string;
    private readonly signers: Signer[];

    constructor(root: SolanaBase, instructions: TransactionInstruction[] | TransactionInstruction, computeBudget: number, feeRate?: string, signers?: Signer[]) {
        this.root = root;
        this.instructions = Array.isArray(instructions) ? instructions : [instructions];
        this.computeBudget = computeBudget;
        this.feeRate = feeRate;
        this.signers = signers || [];
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

    ixs(): TransactionInstruction[] {
        return this.instructions;
    }

    addIxs(instructions: TransactionInstruction[]): number {
        this.instructions.forEach(ix => instructions.push(ix));
        return this.computeBudget || 0;
    }

    async tx(feeRate?: string): Promise<SolanaTx> {
        const tx = new Transaction();
        tx.feePayer = this.root.provider.publicKey;

        if(feeRate==null) feeRate = this.feeRate;
        if(feeRate==null) feeRate = await this.estimateFee();

        SolanaFees.applyFeeRate(tx, this.computeBudget, feeRate);
        this.instructions.forEach(ix => tx.add(ix));
        SolanaFees.applyFeeRateEnd(tx, this.computeBudget, feeRate);

        return {
            tx,
            signers: this.signers
        }
    }

    async addTx(txs: SolanaTx[], feeRate?: string): Promise<void> {
        txs.push(await this.tx(feeRate));
    }

    // combine(action: SolanaAction): SolanaAction {
    //     action.addIxs(this.instructions);
    //     if(this.computeBudget==null && action.computeBudget!=null) this.computeBudget = action.computeBudget;
    //     if(this.computeBudget!=null && action.computeBudget!=null) this.computeBudget += action.computeBudget;
    //     return this;
    // }

}