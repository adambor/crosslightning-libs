import {AnchorProvider, BorshCoder} from "@coral-xyz/anchor";
import {Message, PublicKey} from "@solana/web3.js";
import {ChainEvents, ClaimEvent, EventListener, InitializeEvent, RefundEvent} from "crosslightning-base";
import {IdlInstruction} from "@coral-xyz/anchor/dist/cjs/idl";
import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import * as BN from "bn.js";

export type IxWithAccounts = ({name: string, data: any, accounts: {[key: string]: PublicKey}});

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

            const tx = await this.provider.connection.getTransaction(signature);

            if(tx==null) return;

            const ixs = this.decodeInstructions(tx.transaction.message);

            let parsedEvent: InitializeEvent<SolanaSwapData>;

            for(let ix of ixs) {
                if (ix == null) continue;

                if (
                    (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
                ) {
                    const paymentHash: Buffer = Buffer.from(ix.data.hash);

                    if(!paymentHashBuffer.equals(paymentHash)) continue;

                    const txoHash: Buffer = Buffer.from(event.txoHash);

                    let securityDeposit: BN = new BN(0);
                    let claimerBounty: BN = new BN(0);
                    let payIn: boolean;
                    if(ix.name === "offererInitializePayIn") {
                        payIn = true;
                    } else {
                        payIn = false;
                        securityDeposit = ix.data.securityDeposit;
                        claimerBounty = ix.data.claimerBounty;
                    }

                    const swapData: SolanaSwapData = new SolanaSwapData(
                        ix.accounts.offerer,
                        ix.accounts.claimer,
                        ix.accounts.mint,
                        ix.data.initializerAmount,
                        paymentHash.toString("hex"),
                        ix.data.expiry,
                        ix.data.escrowNonce,
                        ix.data.confirmations,
                        ix.data.payOut,
                        ix.data.kind,
                        payIn,
                        ix.accounts.initializerDepositTokenAccount, //32 bytes
                        ix.accounts.claimerTokenAccount,
                        securityDeposit,
                        claimerBounty,
                        Buffer.from(event.txoHash).toString("hex")
                    );

                    //const usedNonce = ix.data.nonce.toNumber();

                    parsedEvent = new InitializeEvent<SolanaSwapData>(
                        paymentHash.toString("hex"),
                        txoHash.toString("hex"),
                        0,
                        swapData
                    );
                }
            }

            if(parsedEvent==null) return;

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }

        }));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("ClaimEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");
            const secret = Buffer.from(event.secret).toString("hex");

            const parsedEvent = new ClaimEvent<SolanaSwapData>(paymentHash, secret);

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }
        }));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("RefundEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");

            const parsedEvent = new RefundEvent<SolanaSwapData>(paymentHash);

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
