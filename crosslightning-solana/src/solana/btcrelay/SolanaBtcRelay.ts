import {AnchorProvider} from "@coral-xyz/anchor";
import {
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
import {SolanaFees} from "../..";
import {MethodsBuilder} from "@coral-xyz/anchor/dist/cjs/program/namespace/methods";
import {SolanaProgramBase} from "../program/SolanaProgramBase";
import BN from "bn.js";
import {SolanaAction} from "../base/SolanaAction";

const BASE_FEE_SOL_PER_BLOCKHEADER = new BN(5000);

const MAX_CLOSE_IX_PER_TX = 10;

function serializeBlockHeader(e: BtcBlock): SolanaBtcHeader {
    return new SolanaBtcHeader({
        version: e.getVersion(),
        reversedPrevBlockhash: [...Buffer.from(e.getPrevBlockhash(), "hex").reverse()],
        merkleRoot: [...Buffer.from(e.getMerkleRoot(), "hex").reverse()],
        timestamp: e.getTimestamp(),
        nbits: e.getNbits(),
        nonce: e.getNonce(),
        hash: Buffer.from(e.getHash(), "hex").reverse()
    });
};

export class SolanaBtcRelay<B extends BtcBlock> extends SolanaProgramBase<any> implements BtcRelay<SolanaBtcStoredHeader, {tx: Transaction, signers: Signer[]}, B> {

    private async Initialize(header: B, epochStart: number, pastBlocksTimestamps: number[]): Promise<SolanaAction> {
        const serializedBlock = serializeBlockHeader(header);
        return new SolanaAction(this,
            await this.program.methods
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
                .instruction()
        )
    }

    /**
     * Creates verify action to be used with the swap program
     *
     * @param reversedTxId
     * @param confirmations
     * @param position
     * @param reversedMerkleProof
     * @param committedHeader
     */
    public async Verify(
        reversedTxId: Buffer,
        confirmations: number,
        position: number,
        reversedMerkleProof: Buffer[],
        committedHeader: SolanaBtcStoredHeader
    ): Promise<SolanaAction> {
        return new SolanaAction(this,
            await this.program.methods
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
                .instruction(),
            null,
            null,
            null,
            true
        );
    }

    BtcRelayMainState = this.pda("state");
    BtcRelayHeader = this.pda("header", (hash: Buffer) => [hash]);
    BtcRelayFork = this.pda("fork",
        (forkId: number, pubkey: PublicKey) => [new BN(forkId).toBuffer("le", 8), pubkey.toBuffer()]
    );

    bitcoinRpc: BitcoinRpc<B>;

    readonly maxHeadersPerTx: number = 5;
    readonly maxForkHeadersPerTx: number = 4;
    readonly maxShortForkHeadersPerTx: number = 4;

    constructor(
        provider: AnchorProvider,
        bitcoinRpc: BitcoinRpc<B>,
        programAddress?: string,
        solanaFeeEstimator: SolanaFees = new SolanaFees(provider.connection)
    ) {
        super(provider, programIdl, programAddress, null, solanaFeeEstimator);
        this.bitcoinRpc = bitcoinRpc;
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
     * Computes subsequent commited headers as they will appear on the blockchain when transactions
     *  are submitted & confirmed
     *
     * @param initialStoredHeader
     * @param syncedHeaders
     * @private
     */
    private computeCommitedHeaders(initialStoredHeader: SolanaBtcStoredHeader, syncedHeaders: SolanaBtcHeader[]) {
        const computedCommitedHeaders = [initialStoredHeader];
        for(let blockHeader of syncedHeaders) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }
        return computedCommitedHeaders;
    }

    /**
     * A common logic for submitting blockheaders in a transaction
     *
     * @param headers headers to sync to the btc relay
     * @param storedHeader current latest stored block header for a given fork
     * @param tipWork work of the current tip in a given fork
     * @param forkId forkId to submit to, forkId=0 means main chain
     * @param feeRate feeRate for the transaction
     * @param createTx transaction generator function
     * @private
     */
    private async _saveHeaders(
        headers: BtcBlock[],
        storedHeader: SolanaBtcStoredHeader,
        tipWork: Buffer,
        forkId: number,
        feeRate: string,
        createTx: (blockHeaders: SolanaBtcHeader[]) => MethodsBuilder<any, any>
    ) {
        const blockHeaderObj = headers.map(serializeBlockHeader);

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

        this.Fees.applyFeeRateBegin(tx, null, feeRate);
        this.Fees.applyFeeRateEnd(tx, null, feeRate);

        const computedCommitedHeaders = this.computeCommitedHeaders(storedHeader, blockHeaderObj);
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

    /**
     * Returns data about current main chain tip stored in the btc relay
     */
    public async getTipData(): Promise<{ commitHash: string; blockhash: string, chainWork: Buffer, blockheight: number }> {
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
     * Retrieves blockheader with a specific blockhash, returns null if requiredBlockheight is provided and
     *  btc relay contract is not synced up to the desired blockheight
     *
     * @param blockData
     * @param requiredBlockheight
     */
    public async retrieveLogAndBlockheight(blockData: {blockhash: string}, requiredBlockheight?: number): Promise<{
        header: SolanaBtcStoredHeader,
        height: number
    } | null> {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        if(requiredBlockheight!=null && mainState.blockHeight < requiredBlockheight) {
            return null;
        }

        const storedCommitments = this.getBlockCommitmentsSet(mainState);
        const blockHashBuffer = Buffer.from(blockData.blockhash, 'hex').reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        const data = await this.Events.findInEvents(topicKey, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                if(blockHashBuffer.equals(Buffer.from(eventData.blockHash)) && storedCommitments.has(commitHash))
                    return {
                        header: new SolanaBtcStoredHeader(eventData.header as SolanaBtcStoredHeaderType),
                        height: mainState.blockHeight as number,
                        commitHash
                    };
            }
        });
        if(data!=null) this.logger.debug("retrieveLogAndBlockheight(): block found," +
            " commit hash: "+data.commitHash+" blockhash: "+blockData.blockhash+" height: "+data.height);

        return data;
    }

    /**
     * Retrieves blockheader data by blockheader's commit hash,
     *
     * @param commitmentHashStr
     * @param blockData
     */
    public async retrieveLogByCommitHash(commitmentHashStr: string, blockData: {blockhash: string}): Promise<SolanaBtcStoredHeader> {
        const blockHashBuffer = Buffer.from(blockData.blockhash, "hex").reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        const data = await this.Events.findInEvents(topicKey, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                if(commitmentHashStr===commitHash)
                    return new SolanaBtcStoredHeader(eventData.header as SolanaBtcStoredHeaderType);
            }
        });
        if(data!=null) this.logger.debug("retrieveLogByCommitHash(): block found," +
            " commit hash: "+commitmentHashStr+" blockhash: "+blockData.blockhash+" height: "+data.blockheight);

        return data;
    }

    /**
     * Retrieves latest known stored blockheader & blockheader from bitcoin RPC that is in the main chain
     */
    public async retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: SolanaBtcStoredHeader,
        resultBitcoinHeader: B
    }> {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        const storedCommitments = this.getBlockCommitmentsSet(mainState);

        const data = await this.Events.findInEvents(this.program.programId, async (event) => {
            if(event.name==="StoreFork" || event.name==="StoreHeader") {
                const eventData: any = event.data;
                const blockHashHex = Buffer.from(eventData.blockHash).reverse().toString("hex");
                const isInMainChain = await this.bitcoinRpc.isInMainChain(blockHashHex).catch(() => false);
                const commitHash = Buffer.from(eventData.commitHash).toString("hex");
                //Check if this fork is part of main chain
                if(isInMainChain && storedCommitments.has(commitHash))
                    return {
                        resultStoredHeader: new SolanaBtcStoredHeader(eventData.header),
                        resultBitcoinHeader: await this.bitcoinRpc.getBlockHeader(blockHashHex),
                        commitHash: commitHash
                    };
            }
        });
        if(data!=null) this.logger.debug("retrieveLatestKnownBlockLog(): block found," +
            " commit hash: "+data.commitHash+" blockhash: "+data.resultBitcoinHeader.getHash()+
            " height: "+data.resultStoredHeader.blockheight);

        return data;
    }

    /**
     * Saves initial block header when the btc relay is in uninitialized state
     *
     * @param header a bitcoin blockheader to submit
     * @param epochStart timestamp of the start of the epoch (block timestamp at blockheight-(blockheight%2016))
     * @param pastBlocksTimestamps timestamp of the past 10 blocks
     * @param feeRate fee rate to use for the transaction
     */
    async saveInitialHeader(
        header: B,
        epochStart: number,
        pastBlocksTimestamps: number[],
        feeRate?: string
    ): Promise<{ tx: Transaction; signers: Signer[]; }> {
        if(pastBlocksTimestamps.length!==10) throw new Error("Invalid prevBlocksTimestamps");

        const action = await this.Initialize(header, epochStart, pastBlocksTimestamps);

        this.logger.debug("saveInitialHeader(): saving initial header, blockhash: "+header.getHash()+
            " blockheight: "+header.getHeight()+" epochStart: "+epochStart+" past block timestamps: "+pastBlocksTimestamps.join());

        return await action.tx(feeRate);
    }

    /**
     * Saves blockheaders as a bitcoin main chain to the btc relay
     *
     * @param mainHeaders
     * @param storedHeader
     * @param feeRate
     */
    public saveMainHeaders(mainHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, feeRate?: string) {
        this.logger.debug("saveMainHeaders(): submitting main blockheaders, count: "+mainHeaders.length);
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

    /**
     * Creates a new long fork and submits the headers to it
     *
     * @param forkHeaders
     * @param storedHeader
     * @param tipWork
     * @param feeRate
     */
    public async saveNewForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer, feeRate?: string) {
        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        let forkId: BN = mainState.forkCounter;

        this.logger.debug("saveNewForkHeaders(): submitting new fork & blockheaders," +
            " count: "+forkHeaders.length+" forkId: "+forkId.toString(10));
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

    /**
     * Continues submitting blockheaders to a given fork
     *
     * @param forkHeaders
     * @param storedHeader
     * @param forkId
     * @param tipWork
     * @param feeRate
     */
    public saveForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, forkId: number, tipWork: Buffer, feeRate?: string) {
        this.logger.debug("saveForkHeaders(): submitting blockheaders to existing fork," +
            " count: "+forkHeaders.length+" forkId: "+forkId.toString(10));
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

    /**
     * Submits short fork with given blockheaders
     *
     * @param forkHeaders
     * @param storedHeader
     * @param tipWork
     * @param feeRate
     */
    public saveShortForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer, feeRate?: string) {
        this.logger.debug("saveShortForkHeaders(): submitting short fork blockheaders," +
            " count: "+forkHeaders.length);
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

    /**
     * Sweeps fork data PDAs back to self
     *
     * @param lastSweepId lastCheckedId returned from the previous sweepForkData() call
     * @returns {number} lastCheckedId that should be passed to the next call of sweepForkData()
     */
    public async sweepForkData(lastSweepId?: number): Promise<number | null> {
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

            this.logger.info("sweepForkData(): sweeping forkId: "+i);

            if(tx.instructions.length>=MAX_CLOSE_IX_PER_TX) {
                const signature = await this.provider.sendAndConfirm(tx);
                this.logger.info("sweepForkData(): forks swept, signature"+signature);
                tx = new Transaction();
            }

            lastCheckedId = i;
        }

        if(tx.instructions.length>0) {
            const signature = await this.provider.sendAndConfirm(tx);
            this.logger.info("sweepForkData(): forks swept, signature"+signature);
        }

        return lastCheckedId;
    }

    /**
     * Estimate required synchronization fee (worst case) to synchronize btc relay to the required blockheight
     *
     * @param requiredBlockheight
     * @param feeRate
     */
    public async estimateSynchronizeFee(requiredBlockheight: number, feeRate?: string): Promise<BN> {
        const tipData = await this.getTipData();
        const currBlockheight = tipData.blockheight;

        const blockheightDelta = requiredBlockheight-currBlockheight;

        if(blockheightDelta<=0) return new BN(0);

        const synchronizationFee = new BN(blockheightDelta).mul(await this.getFeePerBlock(feeRate));
        this.logger.debug("estimateSynchronizeFee(): required blockheight: "+requiredBlockheight+
            " blockheight delta: "+blockheightDelta+" fee: "+synchronizationFee.toString(10));

        return synchronizationFee;
    }

    /**
     * Returns fee required (in SOL) to synchronize a single block to btc relay
     *
     * @param feeRate
     */
    public async getFeePerBlock(feeRate?: string): Promise<BN> {
        feeRate = feeRate || await this.getMainFeeRate();
        return BASE_FEE_SOL_PER_BLOCKHEADER.add(this.Fees.getPriorityFee(200000, feeRate, false));
    }

    /**
     * Gets fee rate required for submitting blockheaders to the main chain
     */
    public getMainFeeRate(): Promise<string> {
        return this.Fees.getFeeRate([
            this.provider.publicKey,
            this.BtcRelayMainState
        ]);
    }

    /**
     * Gets fee rate required for submitting blockheaders to the specific fork
     */
    public getForkFeeRate(forkId: number): Promise<string> {
        return this.Fees.getFeeRate([
            this.provider.publicKey,
            this.BtcRelayMainState,
            this.BtcRelayFork(forkId, this.provider.publicKey)
        ]);
    }

}
