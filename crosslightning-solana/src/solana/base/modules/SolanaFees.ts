import * as BN from "bn.js";
import {
    ComputeBudgetProgram,
    Connection,
    ParsedNoneModeBlockResponse,
    PublicKey,
    SendOptions,
    SystemInstruction,
    SystemProgram,
    Transaction
} from "@solana/web3.js";
import {getLogger, SolanaTxUtils} from "../../../utils/Utils";

const MAX_FEE_AGE = 5000;

export type FeeBribeData = {
    address: string,
    endpoint: string,
    getBribeFee?: (original: BN) => BN
};

export class SolanaFees {

    private readonly connection: Connection;
    private readonly maxFeeMicroLamports: BN;
    private readonly numSamples: number;
    private readonly period: number;
    private useHeliusApi: "yes" | "no" | "auto";
    private heliusApiSupported: boolean = true;
    private readonly bribeData?: FeeBribeData;
    private readonly getStaticFee?: (original: BN) => BN;

    private readonly logger = getLogger("SolanaFees: ");

    private blockFeeCache: {
        timestamp: number,
        feeRate: Promise<BN>
    } = null;

    constructor(
        connection: Connection,
        maxFeeMicroLamports: number = 250000,
        numSamples: number = 8,
        period: number = 150,
        useHeliusApi: "yes" | "no" | "auto" = "auto",
        getStaticFee?: (feeRate: BN) => BN,
        bribeData?: FeeBribeData,
    ) {
        this.connection = connection;
        this.maxFeeMicroLamports = new BN(maxFeeMicroLamports);
        this.numSamples = numSamples;
        this.period = period;
        this.useHeliusApi = useHeliusApi;
        this.bribeData = bribeData;
        this.getStaticFee = getStaticFee;
    }

    /**
     * Returns solana block with transactionDetails="signatures"
     *
     * @param slot
     * @private
     */
    private async getBlockWithSignature(slot: number): Promise<ParsedNoneModeBlockResponse & {signatures: string[]}> {
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

        return response.result;
    }

    /**
     * Returns fee estimate from Helius API - only works with Helius RPC, return null for all other RPC providers
     *
     * @param mutableAccounts
     * @private
     */
    private async getPriorityFeeEstimate(mutableAccounts: PublicKey[]): Promise<{
        "min": number,
        "low": number,
        "medium": number,
        "high": number,
        "veryHigh": number,
        "unsafeMax": number
    } | null> {
        //Try to use getPriorityFeeEstimate api of Helius
        const response = await (this.connection as any)._rpcRequest("getPriorityFeeEstimate", [
            {
                "accountKeys": mutableAccounts.map(e => e.toBase58()),
                "options": {
                    "includeAllPriorityFeeLevels": true
                }
            }
        ]).catch(e => {
            //Catching not supported errors
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

        if(response.error!=null) {
            //Catching not supported errors
            if(response.error.code!==-32601 && response.error.code!==-32600) throw new Error(response.error.message);
            return null;
        }

        return response.result.priorityFeeLevels;
    }

    /**
     * Sends the transaction over Jito
     *
     * @param tx
     * @param options
     * @private
     * @returns {Promise<string>} transaction signature
     */
    private async sendJitoTx(tx: Buffer, options?: SendOptions): Promise<string> {
        if(this.bribeData?.endpoint==null) throw new Error("Jito endpoint not specified!");
        if(options==null) options = {};
        const request = await fetch(this.bribeData.endpoint, {
            method: "POST",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendTransaction",
                params: [tx.toString("base64"), {
                    ...options,
                    encoding: "base64"
                }],
            }),
            headers: {
                "Content-Type": "application/json"
            }
        });

        if(request.ok) {
            const parsedResponse = await request.json();
            // console.log(parsedResponse);
            return parsedResponse.result;
        }

        throw new Error(await request.text());
    }

    /**
     * Checks whether the transaction should be sent over Jito, returns the fee paid to Jito in case the transaction
     *  should be sent over Jito, returns null if the transaction shouldn't be sent over Jito
     *
     * @param parsedTx
     * @private
     */
    private getJitoTxFee(parsedTx: Transaction): BN | null {
        const lastIx = parsedTx.instructions[parsedTx.instructions.length-1];

        if(!lastIx.programId.equals(SystemProgram.programId)) return null;
        if(SystemInstruction.decodeInstructionType(lastIx)!=="Transfer") return null;

        const decodedIxData = SystemInstruction.decodeTransfer(lastIx);
        if(decodedIxData.toPubkey.toBase58()!==this.bribeData?.address) return null;
        return new BN(decodedIxData.lamports.toString(10));
    }

    /**
     * Gets the mean microLamports/CU fee rate for the block at a specific slot
     *
     * @param slot
     * @private
     */
    private async getBlockMeanFeeRate(slot: number): Promise<BN | null> {
        const block = await this.getBlockWithSignature(slot);
        if(block==null) return null;

        const blockComission = block.rewards.find(e => e.rewardType==="Fee");
        const totalBlockFees = new BN(blockComission.lamports).mul(new BN(2));

        //Subtract per-signature fees to get pure compute fees
        const totalTransactionBaseFees = new BN(block.signatures.length).mul(new BN(5000));
        const computeFees = totalBlockFees.sub(totalTransactionBaseFees);

        //Total compute fees in micro lamports
        const computeFeesMicroLamports = computeFees.mul(new BN(1000000));
        //micro lamports per CU considering block was full (48M compute units)
        const perCUMicroLamports = computeFeesMicroLamports.div(new BN(48000000));

        this.logger.debug("getBlockMeanFeeRate(): slot: "+slot+" total reward: "+totalBlockFees.toString(10)+
            " total transactions: "+block.signatures.length+" computed fee: "+perCUMicroLamports);

        return perCUMicroLamports;
    }

    /**
     * Manually gets global fee rate by sampling random blocks over the last period
     *
     * @private
     * @returns {Promise<BN>} sampled mean microLamports/CU fee over the last period
     */
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

        if(min!=null) this.logger.debug("_getGlobalFeeRate(): slot: "+slot+" global fee minimum: "+min.toString(10));

        return min;
    }

    /**
     * Gets the combined microLamports/CU fee rate (from localized & global fee market)
     *
     * @param mutableAccounts
     * @private
     */
    private async _getFeeRate(mutableAccounts: PublicKey[]): Promise<BN> {
        if(this.useHeliusApi==="yes" || (this.useHeliusApi==="auto" && this.heliusApiSupported)) {
            //Try to use getPriorityFeeEstimate api of Helius
            const fees = await this.getPriorityFeeEstimate(mutableAccounts);
            if(fees!=null) {
                const calculatedFee = BN.max(new BN(8000), new BN(fees.veryHigh));
                return BN.min(calculatedFee, this.maxFeeMicroLamports);
            }
            this.logger.warn("_getFeeRate(): tried fetching fees from Helius API, not supported," +
                " falling back to client-side fee estimation");
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

    /**
     * Gets global fee rate, with caching
     *
     * @returns {Promise<BN>} global fee rate microLamports/CU
     */
    public getGlobalFeeRate(): Promise<BN> {
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
        }

        return this.blockFeeCache.feeRate;
    }

    /**
     * Gets the combined microLamports/CU fee rate (from localized & global fee market), cached & adjusted as for
     *  when bribe and/or static fee should be included, format: <uLamports/CU>;<static fee lamport>[;<bribe address>]
     *
     * @param mutableAccounts
     * @private
     */
    public async getFeeRate(mutableAccounts: PublicKey[]): Promise<string> {
        let feeMicroLamportPerCU = await this._getFeeRate(mutableAccounts);
        if(this.bribeData?.getBribeFee!=null) feeMicroLamportPerCU = this.bribeData.getBribeFee(feeMicroLamportPerCU);

        let fee: string = feeMicroLamportPerCU.toString(10);
        if(this.getStaticFee!=null) {
            fee += ";"+this.getStaticFee(feeMicroLamportPerCU);
        } else {
            fee += ";0"
        }

        if(this.bribeData?.address) {
            fee += ";"+this.bribeData.address;
        }

        this.logger.debug("getFeeRate(): calculated fee: "+fee);

        return fee;
    }

    /**
     * Calculates the total priority fee paid for a given compute budget at a given fee rate
     *
     * @param computeUnits
     * @param feeRate
     * @param includeStaticFee whether the include the static/base part of the fee rate
     */
    public getPriorityFee(computeUnits: number, feeRate: string, includeStaticFee: boolean = true): BN {
        if(feeRate==null) return new BN(0);

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        const arr = feeRate.split(";");
        const cuPrice = new BN(arr[0]);
        const staticFee = includeStaticFee ? new BN(arr[1]) : new BN(0);

        return staticFee.add(cuPrice.mul(new BN(computeUnits)).div(new BN(1000000)));
    }

    /**
     * Applies fee rate to a transaction at the beginning of the transaction (has to be called after
     *  feePayer is set for the tx), specifically adds the setComputeUnitLimit & setComputeUnitPrice instruction
     *
     * @param tx
     * @param computeBudget
     * @param feeRate
     */
    public applyFeeRateBegin(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        if(computeBudget!=null && computeBudget>0) tx.add(ComputeBudgetProgram.setComputeUnitLimit({
            units: computeBudget,
        }));

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {

        } else {
            let fee: bigint = BigInt(arr[0]);
            if(arr.length>1) {
                const staticFee = BigInt(arr[1]);
                const cuBigInt = BigInt(computeBudget || (200000*SolanaTxUtils.getNonComputeBudgetIxs(tx)));
                const staticFeePerCU = staticFee*BigInt(1000000)/cuBigInt;
                fee += staticFeePerCU;
            }
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            }));
        }
    }

    /**
     * Applies fee rate to the end of the transaction (has to be called after feePayer is set for the tx),
     *  specifically adds the bribe SystemProgram.transfer instruction
     *
     * @param tx
     * @param computeBudget
     * @param feeRate
     */
    public applyFeeRateEnd(tx: Transaction, computeBudget: number, feeRate: string): boolean {
        if(feeRate==null) return false;

        const hashArr = feeRate.split("#");
        if(hashArr.length>1) {
            feeRate = hashArr[0];
        }

        //Check if bribe is included
        const arr = feeRate.split(";");
        if(arr.length>2) {
            const cuBigInt = BigInt(computeBudget || (200000*(SolanaTxUtils.getNonComputeBudgetIxs(tx)+1)));
            const cuPrice = BigInt(arr[0]);
            const staticFee = BigInt(arr[1]);
            const bribeAddress = new PublicKey(arr[2]);
            tx.add(SystemProgram.transfer({
                fromPubkey: tx.feePayer,
                toPubkey: bribeAddress,
                lamports: staticFee + (cuBigInt*cuPrice/BigInt(1000000))
            }));
            return;
        }
    }

    /**
     * Checks if the transaction should be submitted over Jito and if yes submits it
     *
     * @param tx
     * @param options
     * @returns {Promise<string | null>} null if the transaction was not sent over Jito, tx signature when tx was sent over Jito
     */
    submitTx(tx: Buffer, options?: SendOptions): Promise<string | null> {
        const parsedTx = Transaction.from(tx);
        const jitoFee = this.getJitoTxFee(parsedTx);
        if(jitoFee==null) return null;

        this.logger.info("submitTx(): sending tx over Jito, signature: "+parsedTx.signature+" fee: "+jitoFee.toString(10));
        return this.sendJitoTx(tx, options);
    }

}