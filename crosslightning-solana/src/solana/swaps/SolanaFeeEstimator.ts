import * as BN from "bn.js";
import {Connection, PublicKey} from "@solana/web3.js";


export class SolanaFeeEstimator {

    connection: Connection;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    private async getBlockMeanFeeRate(slot: number): Promise<BN | null> {

        try {
            const response = await (this.connection as any)._rpcRequest("getBlock", [
                slot,
                {
                    encoding: "json",
                    transactionDetails: "signatures",
                    commitment: "confirmed",
                    rewards: true
                }
            ]);

            const block = response.result;

            const blockComission = block.rewards.find(e => e.rewardType==="Fee");

            const totalBlockFees = new BN(blockComission.lamports).mul(new BN(2));

            //Subtract per-signature fee
            const computeFees = totalBlockFees.sub(new BN(block.signatures.length).mul(new BN(5000)));

            const computeFeesMicroLamports = computeFees.mul(new BN(1000000));

            const perCUMicroLamports = computeFeesMicroLamports.div(new BN(48000000));

            return perCUMicroLamports;
        } catch (e) {
            if(e.code===-32004 || e.code===-32007 || e.code===-32009 || e.code===-32014) {
                return null;
            }
            throw e;
        }

    }

    private async getGlobalFeeRate(numSamples: number = 8, period: number = 150): Promise<BN> {

        let slot = await this.connection.getSlot();

        const slots: number[] = [];

        for(let i=0;i<period;i++) {
            slots.push(slot-i);
        }

        const promises: Promise<BN>[] = [];
        for(let i=0;i<numSamples;i++) {
            promises.push((async () => {
                let feeRate: BN = null;
                while(feeRate==null) {
                    if(slots.length===0) throw new Error("Ran out of slots to check!");
                    const index = Math.floor(Math.random()*slots.length);
                    const slotNumber = slots[index];
                    slots.splice(index, 1);
                    feeRate = await this.getBlockMeanFeeRate(slotNumber);
                }
                return feeRate;
            })());
        }

        const meanFees = await Promise.all(promises);

        let min = null;
        meanFees.forEach(e => min==null ? min = e : min = BN.min(min, e));

        return min;

    }

    async getFeeRate(mutableAccounts: PublicKey[]): Promise<BN> {
        const [globalFeeRate, localFeeRate] = await Promise.all([
            this.getGlobalFeeRate(),
            this.connection.getRecentPrioritizationFees({
                lockedWritableAccounts: mutableAccounts
            }).then(resp => {
                let lamports = 0;
                for(let i=20;i>=0;i--) {
                    const data = resp[resp.length-i-1];
                    if(data!=null) lamports = Math.min(lamports, data.prioritizationFee);
                }
                return new BN(lamports);
            })
        ]);

        const fee =  BN.max(BN.max(globalFeeRate, localFeeRate), new BN(8000));

        return fee;
    }

}