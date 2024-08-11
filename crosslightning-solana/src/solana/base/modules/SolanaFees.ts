import {ComputeBudgetProgram, PublicKey, SystemProgram, Transaction} from "@solana/web3.js";
import {SolanaModule} from "../SolanaModule";


export class SolanaFees extends SolanaModule {

    ///////////////////
    //// Fees
    async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate(mutableAccounts);
    }

    static getTransactionNonCUIxs(tx: Transaction): number {
        let counter = 0;
        for(let ix of tx.instructions) {
            if(!ix.programId.equals(ComputeBudgetProgram.programId)) counter++;
        }
        return counter;
    }

    //Has to be called after feePayer is set for the tx
    static applyFeeRate(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        if(computeBudget!=null) tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget,
        }));

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {

        } else {
            let fee: bigint = BigInt(arr[0]);
            if(arr.length>1) {
                const staticFee = BigInt(arr[1])*BigInt(1000000)/BigInt(computeBudget || (200000*SolanaFees.getTransactionNonCUIxs(tx)));
                fee += staticFee;
            }
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            }));
        }
    }

    static applyFeeRateEnd(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {
            const cuPrice = BigInt(arr[0]);
            const staticFee = BigInt(arr[1]);
            const bribeAddress = new PublicKey(arr[2]);
            tx.add(SystemProgram.transfer({
                fromPubkey: tx.feePayer,
                toPubkey: bribeAddress,
                lamports: staticFee + ((BigInt(computeBudget || (200000*(SolanaFees.getTransactionNonCUIxs(tx)+1)))*cuPrice)/BigInt(1000000))
            }));
            return;
        }
    }

    static getFeePerCU(feeRate: string): string {
        if(feeRate==null) return null;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        const arr = feeRate.split(";");
        return arr.length>1 ? arr[0] : feeRate;
    }

    static getStaticFee(feeRate: string): string {
        if(feeRate==null) return null;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        const arr = feeRate.split(";");
        return arr.length>2 ? arr[1] : "0";
    }


}