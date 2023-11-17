import {AnchorProvider, BN, BorshCoder, EventParser, Program} from "@coral-xyz/anchor";
import {PublicKey, Signer, SystemProgram, Transaction, TransactionInstruction} from "@solana/web3.js";
import {SolanaBtcStoredHeader} from "./headers/SolanaBtcStoredHeader";
import {SolanaBtcHeader} from "./headers/SolanaBtcHeader";
import {programIdl} from "./program/programIdl";
import {BitcoinRpc, BtcBlock, BtcRelay, StatePredictorUtils} from "crosslightning-base";
import {fork} from "child_process";
import {sign} from "tweetnacl";

const LOG_FETCH_LIMIT = 500;

const HEADER_SEED = "header";
const FORK_SEED = "fork";
const BTC_RELAY_STATE_SEED = "state";

const limit = 500;

const SOL_PER_BLOCKHEADER = new BN(5000);

const MAX_CLOSE_IX_PER_TX = 10;

export class SolanaBtcRelay<B extends BtcBlock> implements BtcRelay<SolanaBtcStoredHeader, {tx: Transaction, signers: Signer[]}, B> {

    provider: AnchorProvider;
    programCoder: BorshCoder;
    program: Program;
    eventParser: EventParser;
    BtcRelayMainState: PublicKey;
    BtcRelayHeader: (hash: Buffer) => PublicKey;
    BtcRelayFork: (forkId: number, pubkey: PublicKey) => PublicKey;

    bitcoinRpc: BitcoinRpc<B>;

    readonly maxHeadersPerTx: number = 7;
    readonly maxForkHeadersPerTx: number = 6;
    readonly maxShortForkHeadersPerTx: number = 6;

    constructor(provider: AnchorProvider, bitcoinRpc: BitcoinRpc<B>, programAddress?: string) {
        this.provider = provider;
        this.programCoder = new BorshCoder(programIdl as any);
        this.program = new Program(programIdl as any, programAddress || programIdl.metadata.address, provider);
        this.eventParser = new EventParser(this.program.programId, this.programCoder);

        this.bitcoinRpc = bitcoinRpc;

        this.BtcRelayMainState = PublicKey.findProgramAddressSync(
            [Buffer.from(BTC_RELAY_STATE_SEED)],
            this.program.programId
        )[0];

        this.BtcRelayHeader = (hash: Buffer) => PublicKey.findProgramAddressSync(
            [Buffer.from(HEADER_SEED), hash],
            this.program.programId
        )[0];

        this.BtcRelayFork = (forkId: number, pubkey: PublicKey) => {
            const buff = Buffer.alloc(8);
            buff.writeBigUint64LE(BigInt(forkId));
            return PublicKey.findProgramAddressSync(
                [Buffer.from(FORK_SEED), buff, pubkey.toBuffer()],
                this.program.programId
            )[0];
        }
    }

    async retrieveLogAndBlockheight(blockData: {blockhash: string, height: number}, requiredBlockheight?: number): Promise<{
        header: SolanaBtcStoredHeader,
        height: number
    }> {
        let storedHeader: SolanaBtcStoredHeader = null;

        let lastSignature = null;

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        if(requiredBlockheight!=null) {
            if(mainState.blockHeight < requiredBlockheight) {
                //Btc relay not synchronized to required blockheight
                console.log("not synchronized to required blockheight");
                return null;
            }
        }

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        const blockHashBuffer = Buffer.from(blockData.blockhash, 'hex').reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    before: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(fetched.length===0) break;
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const logData: any = log.data;
                        if(blockHashBuffer.equals(Buffer.from(logData.blockHash))) {
                            const commitHash = Buffer.from(logData.commitHash).toString("hex");
                            if(storedCommitments.has(commitHash)) {
                                storedHeader = new SolanaBtcStoredHeader(log.data.header);
                                break;
                            }
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return {
            header: storedHeader,
            height: mainState.blockHeight
        };
    }

    async retrieveLogByCommitHash(spvCommitmentHashStr: string, blockData: {blockhash: string, height: number}): Promise<SolanaBtcStoredHeader> {
        //Retrieve the log
        const blockHash = Buffer.from(blockData.blockhash, "hex").reverse();
        const spvCommitmentHash = Buffer.from(spvCommitmentHashStr, "hex");

        const topic = this.BtcRelayHeader(blockHash);

        let storedHeader = null;
        let lastSignature = null;
        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        if(Buffer.from(log.data.commitHash).equals(spvCommitmentHash)) {
                            storedHeader = new SolanaBtcStoredHeader(log.data.header);
                            break;
                        }
                    }
                }

                if(storedHeader!=null) break;
            }

        }

        return storedHeader;
    }

    async retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: SolanaBtcStoredHeader,
        resultBitcoinHeader: B
    }> {
        //Retrieve the log
        let storedHeader = null;
        let bitcoinHeader: B = null;

        let lastSignature = null;

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(this.program.programId, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(this.program.programId, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

                const _events = [];
                for(let log of events) {
                    _events.push(log);
                }

                _events.reverse();

                for(let log of _events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const blockHash = Buffer.from(log.data.blockHash);
                        try {
                            const blockHashHex = blockHash.reverse().toString("hex");
                            const isInMainChain = await this.bitcoinRpc.isInMainChain(blockHashHex);
                            if(isInMainChain) {
                                //Check if this fork is part of main chain
                                const commitHash = Buffer.from(log.data.commitHash).toString("hex");
                                if(storedCommitments.has(commitHash)) {
                                    bitcoinHeader = await this.bitcoinRpc.getBlockHeader(blockHashHex);
                                    storedHeader = new SolanaBtcStoredHeader(log.data.header);
                                    break;
                                }
                            }
                        } catch (e) {
                            //Still in a fork
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return {
            resultStoredHeader: storedHeader,
            resultBitcoinHeader: bitcoinHeader
        };
    }

    async retrieveOnchainTip(): Promise<B> {
        const acc = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        let spvTipBlockHeader: B;
        try {
            const blockHashHex = Buffer.from(acc.tipBlockHash).reverse().toString("hex");
            console.log("[BtcRelaySynchronizer]: Stored tip hash: ", blockHashHex);
            const isInMainChain = await this.bitcoinRpc.isInMainChain(blockHashHex);
            if(!isInMainChain) throw new Error("Block not in main chain");
            spvTipBlockHeader = await this.bitcoinRpc.getBlockHeader(blockHashHex);
        } catch (e) {
            console.error(e);
            //Block not found, therefore relay tip is probably in a fork
            const {resultStoredHeader, resultBitcoinHeader} = await this.retrieveLatestKnownBlockLog();
            spvTipBlockHeader = resultBitcoinHeader;
        }

        return spvTipBlockHeader;
    }

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


    async saveInitialHeader(header: BtcBlock, epochStart: number, pastBlocksTimestamps: number[]): Promise<{ tx: Transaction; signers: Signer[]; }> {
        if(pastBlocksTimestamps.length!==10) {
            throw new Error("Invalid prevBlocksTimestamps");
        }

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

        return {
            tx,
            signers: []
        };
    }

    async saveMainHeaders(mainHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader) {
        const blockHeaderObj = mainHeaders.map(SolanaBtcRelay.serializeBlockHeader);

        const tx = await this.program.methods
            .submitBlockHeaders(
                blockHeaderObj,
                storedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }

        return {
            forkId: 0,
            lastStoredHeader: computedCommitedHeaders[computedCommitedHeaders.length-1],
            tx: {
                tx,
                signers: []
            },
            computedCommitedHeaders
        }
    }

    async saveNewForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(SolanaBtcRelay.serializeBlockHeader);

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        let forkId: BN = mainState.forkCounter;

        const tx = await this.program.methods
            .submitForkHeaders(
                blockHeaderObj,
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
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(StatePredictorUtils.gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = new BN(0);
        }

        return {
            forkId: forkId.toNumber(),
            lastStoredHeader: changedCommitedHeader,
            tx: {
                tx,
                signers: []
            },
            computedCommitedHeaders
        }
    }

    async saveForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, forkId: number, tipWork: Buffer): Promise<{
        forkId: number,
        lastStoredHeader: SolanaBtcStoredHeader,
        tx: {
            tx: Transaction,
            signers: Signer[]
        },
        computedCommitedHeaders: SolanaBtcStoredHeader[]
    }> {
        const blockHeaderObj = forkHeaders.map(SolanaBtcRelay.serializeBlockHeader);

        const tx = await this.program.methods
            .submitForkHeaders(
                blockHeaderObj,
                storedHeader,
                forkId,
                false
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState,
                forkState: this.BtcRelayFork(forkId, this.provider.publicKey),
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(StatePredictorUtils.gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = 0;
        }

        return {
            forkId: forkId,
            lastStoredHeader: changedCommitedHeader,
            tx: {
                tx,
                signers: []
            },
            computedCommitedHeaders
        }
    }

    async saveShortForkHeaders(forkHeaders: BtcBlock[], storedHeader: SolanaBtcStoredHeader, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(SolanaBtcRelay.serializeBlockHeader);

        let forkId: BN = new BN(-1);

        const tx = await this.program.methods
            .submitShortForkHeaders(
                blockHeaderObj,
                storedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computedCommitedHeaders[computedCommitedHeaders.length-1].computeNext(blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(StatePredictorUtils.gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = new BN(0);
        }

        return {
            forkId: forkId.toNumber(),
            lastStoredHeader: changedCommitedHeader,
            tx: {
                tx,
                signers: []
            },
            computedCommitedHeaders
        }
    }


    async getTipData(): Promise<{ commitHash: string; blockhash: string, chainWork: Buffer, blockheight: number }> {
        let acc;
        try {
            acc = await this.program.account.mainState.fetch(this.BtcRelayMainState);
        } catch (e) {
            if(e.message.startsWith("Account does not exist or has no data")) return null;
            throw e;
        }

        const spvTipCommitment = Buffer.from(acc.tipCommitHash);
        const blockHashTip = Buffer.from(acc.tipBlockHash);
        const height: BN = new BN(acc.blockHeight);

        return {
            blockheight: height.toNumber(),
            commitHash: spvTipCommitment.toString("hex"),
            blockhash: blockHashTip.reverse().toString("hex"),
            chainWork: Buffer.from(acc.chainWork)
        }
    }

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

    async estimateSynchronizeFee(requiredBlockheight: number): Promise<BN> {
        const tipData = await this.getTipData();
        const currBlockheight = tipData.blockheight;

        const blockheightDelta = requiredBlockheight-currBlockheight;

        if(blockheightDelta<=0) return new BN(0);

        return new BN(blockheightDelta).mul(SOL_PER_BLOCKHEADER);
    }

    getFeePerBlock(): Promise<BN> {
        return Promise.resolve(SOL_PER_BLOCKHEADER);
    }

    async sweepForkData(lastSweepId?: number): Promise<number | null> {

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        let forkId: BN = mainState.forkCounter.toNumber();

        let tx = new Transaction();

        let i = lastSweepId==null ? 0 : lastSweepId+1;
        for(; i<=forkId; i++) {
            const accountAddr = this.BtcRelayFork(i, this.provider.publicKey);
            let forkState: any;
            try {
                forkState = await this.program.account.forkState.fetch(accountAddr);
            } catch (e) {
                if(!e.message.startsWith("Account does not exist or has no data")) throw e;
            }

            if(forkState!=null) {
                const ix = await this.program.methods
                    .closeForkAccount(
                        new BN(i)
                    )
                    .accounts({
                        signer: this.provider.publicKey,
                        forkState: accountAddr,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction();
                tx.add(ix);
                if(tx.instructions.length>=MAX_CLOSE_IX_PER_TX) {
                    const signature = await this.provider.sendAndConfirm(tx);
                    console.log("[SolanaBtcRelay]: Success sweep tx: ", signature);
                    lastSweepId = i;
                    tx = new Transaction();
                }
            }
        }

        if(tx.instructions.length>0) {
            const signature = await this.provider.sendAndConfirm(tx);
            console.log("[SolanaBtcRelay]: Success sweep tx: ", signature);
            lastSweepId = i;
        }

        return i;

    }

}
