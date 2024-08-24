import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {
    ConfirmedSignatureInfo,
    Message,
    ParsedMessage,
    ParsedTransactionWithMeta,
    PartiallyDecodedInstruction,
    PublicKey,
    TransactionResponse
} from "@solana/web3.js";
import {AnchorProvider, Event} from "@coral-xyz/anchor";
import * as fs from "fs/promises";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import * as programIdl from "../swaps/programIdl.json";
import {ChainEvents, SwapEvent, EventListener, ClaimEvent, RefundEvent, InitializeEvent} from "crosslightning-base";
import * as BN from "bn.js";
import {InitializeIxType, InitializePayInIxType, onceAsync} from "../swaps/Utils";
import {SwapProgram} from "../swaps/programTypes";
import {SwapTypeEnum} from "../swaps/SwapTypeEnum";
import {tryWithRetries} from "../../utils/RetryUtils";
import {Buffer} from "buffer";

const BLOCKHEIGHT_FILENAME = "/blockheight.txt";
const LOG_FETCH_INTERVAL = 5*1000;
const LOG_FETCH_LIMIT = 500;

const WS_TX_FETCH_RETRY_TIMEOUT = 500;

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

export type IxWithAccounts = InitializeIxType | InitializePayInIxType;
export type EventObject = {
    events: Event<SwapProgram["events"][number], Record<string, any>>[],
    instructions: IxWithAccounts[],
    blockTime: number,
    signature: string
};

export class SolanaChainEvents implements ChainEvents<SolanaSwapData> {

    private decodeInstructions(transactionMessage: ParsedMessage): IxWithAccounts[] {

        const instructions: IxWithAccounts[] = [];

        for(let _ix of transactionMessage.instructions) {
            if(_ix.programId.equals(this.solanaSwapProgram.program.programId)) {
                if((_ix as PartiallyDecodedInstruction).data!=null) {
                    const ix: PartiallyDecodedInstruction = _ix as PartiallyDecodedInstruction;
                    const parsedIx: any = this.solanaSwapProgram.coder.instruction.decode(ix.data, 'base58');
                    const accountsData = nameMappedInstructions[parsedIx.name];
                    if(accountsData!=null && accountsData.accounts!=null) {
                        parsedIx.accounts = {};
                        for(let i=0;i<accountsData.accounts.length;i++) {
                            parsedIx.accounts[accountsData.accounts[i].name] = ix.accounts[i];
                        }
                    }
                    instructions.push(parsedIx);
                }
            } else {
                instructions.push(null);
            }
        }

        return instructions;

    }

    private readonly listeners: EventListener<SolanaSwapData>[] = [];
    private readonly directory: string;
    private readonly signer: AnchorProvider;
    private readonly solanaSwapProgram: SolanaSwapProgram;
    private readonly logFetchInterval: number;
    private readonly logFetchLimit: number;
    private readonly wsTxFetchRetryTimeout: number;

    constructor(
        directory: string,
        signer: AnchorProvider,
        solanaSwapProgram: SolanaSwapProgram,
        logFetchInterval?: number,
        logFetchLimit?: number,
        wsTxFetchRetryTimeout?: number
    ) {
        this.directory = directory;
        this.signer = signer;
        this.solanaSwapProgram = solanaSwapProgram;
        this.logFetchInterval = logFetchInterval || LOG_FETCH_INTERVAL;
        this.logFetchLimit = logFetchLimit || LOG_FETCH_LIMIT;
        this.wsTxFetchRetryTimeout = wsTxFetchRetryTimeout || WS_TX_FETCH_RETRY_TIMEOUT;
    }

    private async getLastSignature(): Promise<{
        signature: string,
        slot: number
    }> {
        try {
            const txt = (await fs.readFile(this.directory+BLOCKHEIGHT_FILENAME)).toString();
            const arr = txt.split(";");
            if(arr.length<2) return {
                signature: txt,
                slot: 0
            };
            return {
                signature: arr[0],
                slot: parseInt(arr[1])
            };
        } catch (e) {
            return null;
        }
    }

    private saveLastSignature(lastSignture: string, slot: number): Promise<void> {
        return fs.writeFile(this.directory+BLOCKHEIGHT_FILENAME, lastSignture+";"+slot);
    }

    private async processEvent(eventObject : EventObject) {
        let parsedEvents: SwapEvent<SolanaSwapData>[] = [];

        for(let event of eventObject.events) {
            if(event==null) continue;
            if(event.name==="ClaimEvent") {
                const secret: Buffer = Buffer.from(event.data.secret);
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                const parsedEvent = new ClaimEvent<SolanaSwapData>(paymentHash.toString("hex"), event.data.sequence, secret.toString("hex"));
                (parsedEvent as any).meta = {
                    timestamp: eventObject.blockTime,
                    txId: eventObject.signature
                };
                parsedEvents.push(parsedEvent);
            }
            if(event.name==="RefundEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);

                const parsedEvent = new RefundEvent<SolanaSwapData>(paymentHash.toString("hex"), event.data.sequence);
                (parsedEvent as any).meta = {
                    timestamp: eventObject.blockTime,
                    txId: eventObject.signature
                };
                parsedEvents.push(parsedEvent);
            }
            if(event.name==="InitializeEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                // initEvents[paymentHash.toString("hex")] = event;

                const parsedEvent = new InitializeEvent<SolanaSwapData>(
                    paymentHash.toString("hex"),
                    event.data.sequence,
                    Buffer.from(event.data.txoHash).toString("hex"),
                    SwapTypeEnum.toChainSwapType(event.data.kind),
                    onceAsync<SolanaSwapData>(async () => {
                        if(eventObject.instructions==null) {
                            const transaction = await tryWithRetries<ParsedTransactionWithMeta>(async () => {
                                const res = await this.signer.connection.getParsedTransaction(eventObject.signature, {
                                    commitment: "confirmed",
                                    maxSupportedTransactionVersion: 0
                                });
                                if(res==null) throw new Error("Transaction not found!");
                                return res;
                            });
                            if(transaction==null) return null;
                            if(transaction.meta.err==null) {
                                //console.log("Process tx: ", transaction.transaction);
                                //console.log("Decoded ix: ", decodeInstructions(transaction.transaction.message));
                                eventObject.instructions = this.decodeInstructions(transaction.transaction.message);
                            }
                        }
                        if(eventObject.instructions!=null) for(let parsedIx of eventObject.instructions) {
                            if (parsedIx == null) continue;

                            if (
                                (parsedIx.name === "offererInitializePayIn" || parsedIx.name === "offererInitialize")
                            ) {
                                const paymentHash: Buffer = Buffer.from(parsedIx.data.swapData.hash);

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
                                    parsedIx.name === "offererInitializePayIn" ? parsedIx.accounts.offererAta : PublicKey.default, //32 bytes
                                    parsedIx.data.swapData.payOut ? parsedIx.accounts.claimerAta : PublicKey.default,
                                    securityDeposit,
                                    claimerBounty,
                                    Buffer.from(event.data.txoHash).toString("hex")
                                );
                            }
                        }
                    })
                );
                (parsedEvent as any).meta = {
                    timestamp: eventObject.blockTime,
                    txId: eventObject.signature
                };
                parsedEvents.push(parsedEvent);
            }
        }


        for(let listener of this.listeners) {
            await listener(parsedEvents);
        }
    }

    private eventListeners: number[] = [];
    private signaturesProcessing: {
        [signature: string]: {
            promise: Promise<boolean>
        }
    } = {};

    private async fetchTxAndProcessEvent(signature: string): Promise<boolean> {
        try {
            // const result = await this.signer.connection.confirmTransaction(signature);
            // if(result.value.err!=null) {
            //     return true;
            // }
            const transaction = await this.signer.connection.getParsedTransaction(signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0
            });
            if(transaction==null) return false;
            if(transaction.meta.err==null) {
                //console.log("Process tx: ", transaction.transaction);
                //console.log("Decoded ix: ", decodeInstructions(transaction.transaction.message));
                const instructions = this.decodeInstructions(transaction.transaction.message);
                const parsedEvents = this.solanaSwapProgram.eventParser.parseLogs(transaction.meta.logMessages);

                const events = [];
                for(let event of parsedEvents) {
                    events.push(event);
                }

                console.log("Instructions: ", instructions);
                console.log("Events: ", events);

                await this.processEvent({
                    events,
                    instructions,
                    blockTime: transaction.blockTime,
                    signature
                });
            }
        } catch (e) {
            console.error(e);
            return false;
        }
        return true;
    }

    private setupWebsocket() {
        const eventCallback = (name: "InitializeEvent" | "RefundEvent" | "ClaimEvent") => (data, slotNumber, signature) => {
            if(this.signaturesProcessing[signature]!=null) return;

            console.log("[Solana Events WebSocket] Process signature: ", signature);

            const obj: {
                promise: Promise<boolean>,
                timeout: NodeJS.Timeout
            } = {
                promise: null,
                timeout: null
            };

            obj.promise = this.processEvent({
                events: [{name, data}],
                instructions: null,
                blockTime: Math.floor(Date.now()/1000),
                signature
            }).then(() => true).catch(e => {
                console.error(e);
                return false;
            });

            this.signaturesProcessing[signature] = obj;

        };

        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("InitializeEvent", eventCallback("InitializeEvent")));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("ClaimEvent", eventCallback("ClaimEvent")));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("RefundEvent", eventCallback("RefundEvent")));

    }

    private async checkEvents() {
        const lastSignature = await this.getLastSignature();

        let signatures: ConfirmedSignatureInfo[] = null;

        if(lastSignature==null) {
            signatures = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                limit: 1
            }, "confirmed");
            if(signatures.length>0) {
                await this.saveLastSignature(signatures[0].signature, signatures[0].slot);
            }
            return;
        }

        let fetched = null;
        while(fetched==null || fetched.length===this.logFetchLimit) {
            if(signatures==null) {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                    until: lastSignature.signature,
                    limit: this.logFetchLimit
                }, "confirmed");
                //Check if newest returned signature (index 0) is older than the latest signature's slot, this is a sanity check
                if(fetched.length>0 && fetched[0].slot<lastSignature.slot) {
                    console.log("[Solana Events POLL] Sanity check triggered, returned signature slot height is older than latest!");
                    return;
                }
            } else {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                    before: signatures[signatures.length-1].signature,
                    until: lastSignature.signature,
                    limit: this.logFetchLimit
                }, "confirmed");
            }
            if(signatures==null) {
                signatures = fetched;
            } else {
                fetched.forEach(e => signatures.push(e));
            }
        }

        let lastSuccessfulSignature: {signature: string, slot: number} = null;

        try {
            for(let i=signatures.length-1;i>=0;i--) {
                const txSignature = signatures[i];

                const signatureHandlerObj: {
                    promise: Promise<boolean>
                } = this.signaturesProcessing[txSignature.signature];
                if(signatureHandlerObj!=null) {
                    if(await signatureHandlerObj.promise) {
                        lastSuccessfulSignature = txSignature;
                        delete this.signaturesProcessing[txSignature.signature];
                        continue;
                    }
                    delete this.signaturesProcessing[txSignature.signature];
                }

                console.log("[Solana Events POLL] Process signature: ", txSignature);

                const processPromise: Promise<boolean> = this.fetchTxAndProcessEvent(txSignature.signature);
                this.signaturesProcessing[txSignature.signature] = {
                    promise: processPromise
                };
                const result = await processPromise;
                if(!result) throw new Error("Failed to process signature: "+txSignature);
                lastSuccessfulSignature = txSignature;
                delete this.signaturesProcessing[txSignature.signature];
            }
        } catch (e) {
            console.error(e);
        }

        if(lastSuccessfulSignature!=null) {
            await this.saveLastSignature(lastSuccessfulSignature.signature, lastSignature.slot);
        }
    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        let func;
        func = async () => {
            await this.checkEvents().catch(e => {
                console.error("Failed to fetch Sol log");
                console.error(e);
            });
            setTimeout(func, this.logFetchInterval);
        };
        await func();

        this.setupWebsocket();
    }

    registerListener(cbk: EventListener<SolanaSwapData>) {
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
