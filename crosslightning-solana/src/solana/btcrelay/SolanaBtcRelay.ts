import {AnchorProvider, BN, BorshCoder, EventParser, Program, Event} from "@coral-xyz/anchor";
import {
    ConfirmedSignatureInfo,
    PublicKey,
    Signer,
    SystemProgram,
    Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import {SolanaBtcStoredHeader, SolanaBtcStoredHeaderType} from "./headers/SolanaBtcStoredHeader";
import {SolanaBtcHeader} from "./headers/SolanaBtcHeader";
import * as programIdl from "./program/programIdl.json";
import {BitcoinRpc, BtcBlock, BtcRelay, StatePredictorUtils} from "crosslightning-base";
import {SolanaFeeEstimator, SolanaSwapProgram} from "../..";
import { IdlEvent } from "@coral-xyz/anchor/dist/cjs/idl";
import {MethodsBuilder} from "@coral-xyz/anchor/dist/cjs/program/namespace/methods";
import {SolanaProgramBase} from "../SolanaProgramBase";

const HEADER_SEED = "header";
const FORK_SEED = "fork";
const BTC_RELAY_STATE_SEED = "state";

const BASE_FEE_SOL_PER_BLOCKHEADER = new BN(5000);

const MAX_CLOSE_IX_PER_TX = 10;

export class SolanaBtcRelay<B extends BtcBlock> extends SolanaProgramBase<any> implements BtcRelay<SolanaBtcStoredHeader, {tx: Transaction, signers: Signer[]}, B> {

    static serializeBlockHeader(e: BtcBlock): SolanaBtcHeader {
        return new SolanaBtcHeader({
            version: e.getVersion(),
            reversedPrevBlockhash: [...Buffer.from(e.getPrevBlockhash(), "hex").reverse()],
            merkleRoot: [...Buffer.from(e.getMerkleRoot(), "hex").reverse()],
            timestamp: e.getTimestamp(),
            nbits: e.getNbits(),
            nonce: e.getNonce(),
            hash: Buffer.from(e.getHash(), "hex").reverse()
        });
    }

    BtcRelayMainState: PublicKey;
    BtcRelayHeader: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
        [Buffer.from(HEADER_SEED), hash],
        this.program.programId
    )[0];
    BtcRelayFork: (forkId: number, pubkey: PublicKey) => PublicKey = (forkId: number, pubkey: PublicKey) => {
        const buff = Buffer.alloc(8);
        buff.writeBigUint64LE(BigInt(forkId));
        return PublicKey.findProgramAddressSync(
            [Buffer.from(FORK_SEED), buff, pubkey.toBuffer()],
            this.program.programId
        )[0];
    };

    bitcoinRpc: BitcoinRpc<B>;

    readonly maxHeadersPerTx: number = 5;
    readonly maxForkHeadersPerTx: number = 4;
    readonly maxShortForkHeadersPerTx: number = 4;

    constructor(
        provider: AnchorProvider,
        bitcoinRpc: BitcoinRpc<B>,
        programAddress?: string,
        solanaFeeEstimator: SolanaFeeEstimator = new SolanaFeeEstimator(provider.connection)
    ) {
        super(provider, programIdl, programAddress, null, solanaFeeEstimator);
        this.bitcoinRpc = bitcoinRpc;

        this.BtcRelayMainState = PublicKey.findProgramAddressSync(
            [Buffer.from(BTC_RELAY_STATE_SEED)],
            this.program.programId
        )[0];
    }

    /**
     * Gets set of block commitments representing current main chain from the mainState
     *
     * @param mainState
     * @private
     */
    private getBlockCommitmentsSet(mainState: any): Set<string> {
        const storedCommitments = new Set<string>();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });
        return storedCommitments;
    }

    /**
     * Retrieves blockheader with a specific blockhash, alternativelly also requring the btc relay contract to be synced
     *  up to the requiredBlockheight height
     *
     * @param blockData
     * @param requiredBlockheight
     */
    async retrieveLogAndBlockheight(blockData: {blockhash: string}, requiredBlockheight?: number): Promise<{
        header: SolanaBtcStoredHeader,
        height: number
    }> {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        if(requiredBlockheight!=null && mainState.blockHeight < requiredBlockheight) {
            console.log("not synchronized to required blockheight");
            return null;
        }

        const storedCommitments = this.getBlockCommitmentsSet(mainState);
        const blockHashBuffer = Buffer.from(blockData.blockhash, 'hex').reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        return await this.findInEvents(topicKey, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                if(blockHashBuffer.equals(Buffer.from(eventData.blockHash)) && storedCommitments.has(commitHash))
                    return {
                        header: new SolanaBtcStoredHeader(eventData.header as SolanaBtcStoredHeaderType),
                        height: mainState.blockHeight
                    };
            }
        });
    }

    /**
     * Retrieves blockheader data by blockheader's commit hash,
     *
     * @param commitmentHashStr
     * @param blockData
     */
    retrieveLogByCommitHash(commitmentHashStr: string, blockData: {blockhash: string}): Promise<SolanaBtcStoredHeader> {
        const blockHashBuffer = Buffer.from(blockData.blockhash, "hex").reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        return this.findInEvents(topicKey, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                if(commitmentHashStr===commitHash)
                    return new SolanaBtcStoredHeader(eventData.header as SolanaBtcStoredHeaderType);
            }
        });
    }

    /**
     * Retrieves latest known stored blockheader & blockheader from bitcoin RPC that is in the main chain
     */
    async retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: SolanaBtcStoredHeader,
        resultBitcoinHeader: B
    }> {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        const storedCommitments = this.getBlockCommitmentsSet(mainState);

        return await this.findInEvents(this.program.programId, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const blockHashHex = Buffer.from(eventData.blockHash).reverse().toString("hex");
                const isInMainChain = await this.bitcoinRpc.isInMainChain(blockHashHex).catch(() => false);
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                //Check if this fork is part of main chain
                if(isInMainChain && storedCommitments.has(commitHash))
                    return {
                        resultStoredHeader: new SolanaBtcStoredHeader(eventData.header),
                        resultBitcoinHeader: await this.bitcoinRpc.getBlockHeader(blockHashHex)
                    };
            }
        });
    }

    async saveInitialHeader(
        header: BtcBlock,
        epochStart: number,
        pastBlocksTimestamps: number[],
        feeRate?: string
    ): Promise<{ tx: Transaction; signers: Signer[]; }> {
        if(pastBlocksTimestamps.length!==10) throw new Error("Invalid prevBlocksTimestamps");

        const serializedBlock = SolanaBtcRelay.serializeBlockHeader(header);

        const tx = await this.program.methods
            .initialize(
                serializedBlock,
                header.getHeight(),
                header.getChainWork(),
                epochStart,
                pastBlocksTimestamps
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState,
                headerTopic: this.BtcRelayHeader(serializedBlock.hash),
                systemProgram: SystemProgram.programId
            })
            .transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaSwapProgram.applyFeeRate(tx, null, feeRate);
        SolanaSwapProgram.applyFeeRateEnd(tx, null, feeRate);

        return {
            tx,
            signers: []
        };
    }

    private computeComittedHeaders(initialStoredHeader: SolanaBtcStoredHeader, syncedHeaders: SolanaBtcHeader[]) {
        const computedCommitedHeaders = [initialStoredHeader];
        for(let blockHeader of syncedHeaders) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }
        return computedCommitedHeaders;
    }

    async _saveHeaders(
        headers: BtcBlock[],
        storedHeader: SolanaBtcStoredHeader,
        tipWork: Buffer,
        forkId: number,
        feeRate: string,
        createTx: (blockHeaders: SolanaBtcHeader[]) => MethodsBuilder<any, any>
    ) {
        const blockHeaderObj = headers.map(SolanaBtcRelay.serializeBlockHeader);

        const tx = await createTx(blockHeaderObj)
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaSwapProgram.applyFeeRate(tx, null, feeRate);
        SolanaSwapProgram.applyFeeRateEnd(tx, null, feeRate);

        const computedCommitedHeaders = this.computeComittedHeaders(storedHeader, blockHeaderObj);
        const lastStoredHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];
        if(forkId!==0 && StatePredictorUtils.gtBuffer(Buffer.from(lastStoredHeader.chainWork), tipWork)) {
            //Fork's work is higher than main chain's work, this fork will become a main chain
            forkId = 0;
        }

        return {
            forkId: forkId,
            lastStoredHeader,
            tx: {
                tx,
                signers: []
            },
            computedCommitedHeaders
        }
    }

    saveMainHeaders(mainHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, feeRate?: string) {
        return this._saveHeaders(mainHeaders, storedHeader, null, 0, feeRate,
            (blockHeaders) => this.program.methods
                .submitBlockHeaders(
                    blockHeaders,
                    storedHeader
                )
                .accounts({
                    signer: this.provider.publicKey,
                    mainState: this.BtcRelayMainState,
                })
        );
    }

    async saveNewForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer, feeRate?: string) {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        let forkId: BN = mainState.forkCounter;

        return await this._saveHeaders(forkHeaders, storedHeader, tipWork, forkId.toNumber(), feeRate,
            (blockHeaders) => this.program.methods
                .submitForkHeaders(
                    blockHeaders,
                    storedHeader,
                    forkId,
                    true
                )
                .accounts({
                    signer: this.provider.publicKey,
                    mainState: this.BtcRelayMainState,
                    forkState: this.BtcRelayFork(forkId.toNumber(), this.provider.publicKey),
                    systemProgram: SystemProgram.programId,
                })
        );
    }

    saveForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, forkId: number, tipWork: Buffer, feeRate?: string) {
        return this._saveHeaders(forkHeaders, storedHeader, tipWork, forkId, feeRate,
            (blockHeaders) => this.program.methods
                .submitForkHeaders(
                    blockHeaders,
                    storedHeader,
                    new BN(forkId),
                    false
                )
                .accounts({
                    signer: this.provider.publicKey,
                    mainState: this.BtcRelayMainState,
                    forkState: this.BtcRelayFork(forkId, this.provider.publicKey),
                    systemProgram: SystemProgram.programId,
                })
        )
    }

    saveShortForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer, feeRate?: string) {
        return this._saveHeaders(forkHeaders, storedHeader, tipWork, -1, feeRate,
            (blockHeaders) => this.program.methods
                .submitShortForkHeaders(
                    blockHeaders,
                    storedHeader
                )
                .accounts({
                    signer: this.provider.publicKey,
                    mainState: this.BtcRelayMainState
                })
        );
    }

    async getTipData(): Promise<{ commitHash: string; blockhash: string, chainWork: Buffer, blockheight: number }> {
        const data: any = await this.program.account.mainState.fetchNullable(this.BtcRelayMainState);
        if(data==null) return null;

        return {
            blockheight: data.blockHeight,
            commitHash: Buffer.from(data.tipCommitHash).toString("hex"),
            blockhash: Buffer.from(data.tipBlockHash).reverse().toString("hex"),
            chainWork: Buffer.from(data.chainWork)
        }
    }

    /**
     * Creates verify instruction to be used with the swap program
     *
     * @param reversedTxId
     * @param confirmations
     * @param position
     * @param reversedMerkleProof
     * @param committedHeader
     */
    async createVerifyIx(reversedTxId: Buffer, confirmations: number, position: number, reversedMerkleProof: Buffer[], committedHeader: SolanaBtcStoredHeader): Promise<TransactionInstruction> {
        return await this.program.methods
            .verifyTransaction(
                reversedTxId,
                confirmations,
                position,
                reversedMerkleProof,
                committedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState
            })
            .instruction();
    }

    /**
     * Estimate required synchronization fee (worst case) to synchronize btc relay to the required blockheight
     *
     * @param requiredBlockheight
     * @param feeRate
     */
    async estimateSynchronizeFee(requiredBlockheight: number, feeRate?: string): Promise<BN> {
        const tipData = await this.getTipData();
        const currBlockheight = tipData.blockheight;

        const blockheightDelta = requiredBlockheight-currBlockheight;

        if(blockheightDelta<=0) return new BN(0);

        return new BN(blockheightDelta).mul(await this.getFeePerBlock(feeRate));
    }

    /**
     * Returns fee required (in SOL) to synchronize a single block to btc relay
     *
     * @param feeRate
     */
    async getFeePerBlock(feeRate?: string): Promise<BN> {
        feeRate = feeRate || await this.getMainFeeRate();
        const computeBudget = 200000;
        const priorityMicroLamports = new BN(SolanaSwapProgram.getFeePerCU(feeRate)).mul(new BN(computeBudget));
        const priorityLamports = priorityMicroLamports.div(new BN(1000000));

        return BASE_FEE_SOL_PER_BLOCKHEADER.add(priorityLamports);
    }

    /**
     * Sweeps fork data PDAs back to self
     *
     * @param lastSweepId lastCheckedId returned from the previous sweepForkData() call
     * @returns {number} lastCheckedId that should be passed to the next call of sweepForkData()
     */
    async sweepForkData(lastSweepId?: number): Promise<number | null> {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        let forkId: number = mainState.forkCounter.toNumber();

        let tx = new Transaction();

        let lastCheckedId = lastSweepId;
        for(
            let i = lastSweepId==null ? 0 : lastSweepId+1;
            i<=forkId; i++
        ) {
            const accountAddr = this.BtcRelayFork(i, this.provider.publicKey);
            let forkState: any = await this.program.account.forkState.fetchNullable(accountAddr);

            if(forkState==null) continue;

            tx.add(await this.program.methods
                .closeForkAccount(
                    new BN(i)
                )
                .accounts({
                    signer: this.provider.publicKey,
                    forkState: accountAddr,
                    systemProgram: SystemProgram.programId,
                })
                .instruction()
            );

            if(tx.instructions.length>=MAX_CLOSE_IX_PER_TX) {
                const signature = await this.provider.sendAndConfirm(tx);
                console.log("[SolanaBtcRelay]: Success sweep tx: ", signature);
                tx = new Transaction();
            }

            lastCheckedId = i;
        }

        if(tx.instructions.length>0) {
            const signature = await this.provider.sendAndConfirm(tx);
            console.log("[SolanaBtcRelay]: Success sweep tx: ", signature);
        }

        return lastCheckedId;
    }

    getMainFeeRate(): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate([
            this.provider.publicKey,
            this.BtcRelayMainState
        ]);
    }

    getForkFeeRate(forkId: number): Promise<string> {
        return this.solanaFeeEstimator.getFeeRate([
            this.provider.publicKey,
            this.BtcRelayMainState,
            this.BtcRelayFork(forkId, this.provider.publicKey)
        ]);
    }

}
