import {AnchorProvider, BorshCoder, DecodeType, IdlTypes, InstructionFn} from "@coral-xyz/anchor";
import {Message, PublicKey} from "@solana/web3.js";
import {ChainEvents, ClaimEvent, EventListener, InitializeEvent, RefundEvent} from "crosslightning-base";
import {IdlInstruction} from "@coral-xyz/anchor/dist/cjs/idl";
import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import * as BN from "bn.js";
import {SwapTypeEnum} from "../swaps/SwapTypeEnum";
import {InitializeIxType, InitializePayInIxType} from "../swaps/Utils";

export class SolanaChainEventsBrowser implements ChainEvents<SolanaSwapData> {

    private readonly listeners: EventListener<SolanaSwapData>[] = [];

    private readonly provider: AnchorProvider;
    private readonly coder: BorshCoder;
    private readonly solanaSwapProgram: SolanaSwapProgram;

    private eventListeners: number[] = [];
    private readonly nameMappedInstructions: {
        [name: string]: IdlInstruction
    } = {};

    constructor(provider: AnchorProvider, solanaSwapContract: SolanaSwapProgram) {
        this.provider = provider;
        this.solanaSwapProgram = solanaSwapContract;

        this.coder = solanaSwapContract.coder;
        for(let ix of solanaSwapContract.program.idl.instructions) {
            this.nameMappedInstructions[ix.name] = ix;
        }
    }

    decodeInstructions(transactionMessage: Message): {
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
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(this.solanaSwapProgram.program.programId)) {
                const parsedIx: any = this.coder.instruction.decode(ix.data, 'base58') as any;
                const accountsData = this.nameMappedInstructions[parsedIx.name];
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

    init(): Promise<void> {

        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("InitializeEvent", async (event, slotNumber, signature) => {

            const paymentHashBuffer = Buffer.from(event.hash);
            const paymentHashHex = paymentHashBuffer.toString("hex");

            const parsedEvent: InitializeEvent<SolanaSwapData> = new InitializeEvent<SolanaSwapData>(
                paymentHashHex,
                event.sequence,
                Buffer.from(event.txoHash).toString("hex"),
                SwapTypeEnum.toChainSwapType(event.kind),
                async () => {
                    const tx = await this.provider.connection.getTransaction(signature);

                    if(tx==null) return null;

                    const ixs = this.decodeInstructions(tx.transaction.message);

                    for(let ix of ixs) {
                        if (ix == null) continue;

                        if (
                            (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
                        ) {
                            const parsedIx: InitializePayInIxType | InitializeIxType = ix as any;

                            const paymentHash: Buffer = Buffer.from(parsedIx.data.swapData.hash);

                            if(!paymentHashBuffer.equals(paymentHash)) continue;

                            let securityDeposit: BN = new BN(0);
                            let claimerBounty: BN = new BN(0);
                            let payIn: boolean;
                            if(parsedIx.name === "offererInitializePayIn") {
                                payIn = true;

                            } else {
                                payIn = false;
                                securityDeposit = parsedIx.data.securityDeposit;
                                claimerBounty = parsedIx.data.claimerBounty;
                            }

                            return new SolanaSwapData(
                                parsedIx.accounts.offerer,
                                parsedIx.accounts.claimer,
                                parsedIx.accounts.mint,
                                parsedIx.data.swapData.amount,
                                paymentHash.toString("hex"),
                                parsedIx.data.swapData.sequence,
                                parsedIx.data.swapData.expiry,
                                parsedIx.data.swapData.nonce,
                                parsedIx.data.swapData.confirmations,
                                parsedIx.data.swapData.payOut,
                                SwapTypeEnum.toNumber(parsedIx.data.swapData.kind),
                                payIn,
                                parsedIx.name === "offererInitializePayIn" ? parsedIx.accounts.offererAta : undefined, //32 bytes
                                parsedIx.data.swapData.payOut ? parsedIx.accounts.claimerAta : PublicKey.default,
                                securityDeposit,
                                claimerBounty,
                                Buffer.from(event.txoHash).toString("hex")
                            );
                        }
                    }
                }
            );

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }

        }));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("ClaimEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");
            const secret = Buffer.from(event.secret).toString("hex");

            const parsedEvent = new ClaimEvent<SolanaSwapData>(paymentHash, event.sequence, secret);

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }
        }));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("RefundEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");

            const parsedEvent = new RefundEvent<SolanaSwapData>(paymentHash, event.sequence);

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }
        }));

        return Promise.resolve();

    }

    async stop(): Promise<void> {
        for(let num of this.eventListeners) {
            await this.solanaSwapProgram.program.removeEventListener(num);
        }
        this.eventListeners = [];
    }

    registerListener(cbk: EventListener<SolanaSwapData>): void {
        this.listeners.push(cbk);
    }

    unregisterListener(cbk: EventListener<SolanaSwapData>): boolean {
        const index = this.listeners.indexOf(cbk);
        if(index>=0) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    }

}
