import * as BN from "bn.js";
import {Connection, PublicKey} from "@solana/web3.js";

const MAX_FEE_AGE = 5000;

export class SolanaFeeEstimator {

    private readonly connection: Connection;
    private readonly maxFeeMicroLamports: BN;
    private readonly numSamples: number;
    private readonly period: number;
    private useHeliusApi: "yes" | "no" | "auto";
    private heliusApiSupported: boolean = true;

    private blockFeeCache: {
        timestamp: number,
        feeRate: Promise<BN>
    } = null;

    constructor(connection: Connection, maxFeeMicroLamports: number = 250000, numSamples: number = 8, period: number = 150, useHeliusApi: "yes" | "no" | "auto" = "auto") {
        this.connection = connection;
        this.maxFeeMicroLamports = new BN(maxFeeMicroLamports);
        this.numSamples = numSamples;
        this.period = period;
        this.useHeliusApi = useHeliusApi;
    }

    private async getBlockMeanFeeRate(slot: number): Promise<BN | null> {

        //Have to use raw _rpcRequest because getBlock nor getParsedBlock don't work with transactionDetails=signatures
        const response = await (this.connection as any)._rpcRequest("getBlock", [
            slot,
            {
                encoding: "json",
                transactionDetails: "signatures",
                commitment: "confirmed",
                rewards: true
            }
        ]);

        if(response.error!=null) {
            if(response.error.code===-32004 || response.error.code===-32007 || response.error.code===-32009 || response.error.code===-32014) {
                return null;
            }
            throw new Error(response.error.message);
        }

        const block = response.result;

        const blockComission = block.rewards.find(e => e.rewardType==="Fee");

        const totalBlockFees = new BN(blockComission.lamports).mul(new BN(2));

        //Subtract per-signature fee
        const computeFees = totalBlockFees.sub(new BN(block.signatures.length).mul(new BN(5000)));

        const computeFeesMicroLamports = computeFees.mul(new BN(1000000));

        const perCUMicroLamports = computeFeesMicroLamports.div(new BN(48000000));

        return perCUMicroLamports;

    }

    private async _getGlobalFeeRate(): Promise<BN> {

        let slot = await this.connection.getSlot();

        const slots: number[] = [];

        for(let i=0;i<this.period;i++) {
            slots.push(slot-i);
        }

        const promises: Promise<BN>[] = [];
        for(let i=0;i<this.numSamples;i++) {
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

    private async getGlobalFeeRate(): Promise<BN> {

        if(this.blockFeeCache==null || Date.now() - this.blockFeeCache.timestamp > MAX_FEE_AGE) {
            let obj = {
                timestamp: Date.now(),
                feeRate: null
            };
            obj.feeRate = this._getGlobalFeeRate().catch(e => {
                if(this.blockFeeCache===obj) this.blockFeeCache=null;
                throw e;
            });
            this.blockFeeCache = obj;
            return await obj.feeRate;
        }

        // let isRejected = await Promise.race([this.blockFeeCache.feeRate, Promise.resolve()]).then(() => false, () => true);
        //
        // if(isRejected) {
        //     const promise = this._getGlobalFeeRate();
        //     this.blockFeeCache = {
        //         timestamp: Date.now(),
        //         feeRate: promise
        //     };
        //     return await promise;
        // }

        return await this.blockFeeCache.feeRate;

    }

    async getFeeRate(mutableAccounts: PublicKey[]): Promise<BN> {

        if(this.useHeliusApi==="yes" || (this.useHeliusApi==="auto" && this.heliusApiSupported)) {
            //Try to use getPriorityFeeEstimate api of Helius
            const response = await (this.connection as any)._rpcRequest("getPriorityFeeEstimate", [
                {
                    "accountKeys": mutableAccounts.map(e => e.toBase58()),
                    "options": {
                        "includeAllPriorityFeeLevels": true
                    }
                }
            ]).catch(e => {
                if(e.message!=null && (e.message.includes("-32601") || e.message.includes("-32600"))) {
                    return {
                        error: {
                            code: -32601,
                            message: e.message
                        }
                    };
                }
                throw e;
            });

            if(response.error==null) {
                const calculatedFee = BN.max(new BN(8000), new BN(response.result.priorityFeeLevels.veryHigh));
                return BN.min(calculatedFee, this.maxFeeMicroLamports);
            }

            if(response.error!=null) {
                if(response.error.code!==-32601 && response.error.code!==-32600) {
                    throw new Error(response.error.message);
                }
            }

            this.heliusApiSupported = false;
        }

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

        return BN.min(fee, this.maxFeeMicroLamports);
    }

}