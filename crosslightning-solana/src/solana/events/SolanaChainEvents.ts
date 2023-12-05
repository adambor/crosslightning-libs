import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {Message, PublicKey} from "@solana/web3.js";
import {AnchorProvider, Event} from "@coral-xyz/anchor";
import * as fs from "fs/promises";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import {programIdl} from "../swaps/programIdl";
import {IdlEvent} from "@coral-xyz/anchor/dist/esm/idl";
import {ChainEvents, SwapEvent, EventListener, ClaimEvent, RefundEvent, InitializeEvent} from "crosslightning-base";
import * as BN from "bn.js";


const BLOCKHEIGHT_FILENAME = "/blockheight.txt";
const LOG_FETCH_INTERVAL = 5*1000;
const LOG_FETCH_LIMIT = 500;

const WS_TX_FETCH_RETRY_TIMEOUT = 500;

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

export type IxWithAccounts = ({name: string, data: any, accounts: {[key: string]: PublicKey}});
export type EventObject = {
    events: Event<IdlEvent, Record<string, any>>[],
    instructions: IxWithAccounts[]
};

export class SolanaChainEvents implements ChainEvents<SolanaSwapData> {

    private decodeInstructions(transactionMessage: Message): IxWithAccounts[] {

        const instructions: IxWithAccounts[] = [];

        for(let ix of transactionMessage.instructions) {
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(this.solanaSwapProgram.program.programId)) {
                const parsedIx: any = this.solanaSwapProgram.coder.instruction.decode(ix.data, 'base58');
                const accountsData = nameMappedInstructions[parsedIx.name];
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

    private async getLastSignature() {
        try {
            const txt = await fs.readFile(this.directory+BLOCKHEIGHT_FILENAME);
            return txt.toString();
        } catch (e) {
            return null;
        }
    }

    private saveLastSignature(lastSignture: string): Promise<void> {
        return fs.writeFile(this.directory+BLOCKHEIGHT_FILENAME, lastSignture);
    }

    private async processEvent(eventObject : EventObject) {
        let parsedEvents: SwapEvent<SolanaSwapData>[] = [];

        const initEvents = {};

        for(let event of eventObject.events) {
            if(event==null) continue;
            if(event.name==="ClaimEvent") {
                const secret: Buffer = Buffer.from(event.data.secret);
                const paymentHash: Buffer = Buffer.from(event.data.hash);

                parsedEvents.push(new ClaimEvent<SolanaSwapData>(paymentHash.toString("hex"), secret.toString("hex")));
            }
            if(event.name==="RefundEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                parsedEvents.push(new RefundEvent<SolanaSwapData>(paymentHash.toString("hex")));
            }
            if(event.name==="InitializeEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                initEvents[paymentHash.toString("hex")] = event;
            }
        }

        for(let ix of eventObject.instructions) {
            if (ix == null) continue;

            if (
                (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
            ) {
                const paymentHash: Buffer = Buffer.from(ix.data.hash);

                const associatedEvent = initEvents[paymentHash.toString("hex")];

                if(associatedEvent==null) continue;

                const txoHash: Buffer = Buffer.from(associatedEvent.data.txoHash);

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
                    ix.accounts.offerer, //32 bytes
                    ix.accounts.claimer, //32 bytes
                    ix.accounts.mint,    //32 bytes
                    ix.data.initializerAmount, //8 bytes
                    paymentHash.toString("hex"), //32 bytes
                    ix.data.expiry, //8 bytes
                    ix.data.escrowNonce, //8 bytes
                    ix.data.confirmations, //2 bytes
                    ix.data.payOut, //1 byte
                    ix.data.kind, //1 byte
                    payIn, //1 byte
                    ix.accounts.claimerTokenAccount, //32 bytes
                    securityDeposit,
                    claimerBounty,
                    Buffer.from(ix.data.txoHash).toString('hex')
                );

                //const usedNonce = ix.data.nonce.toNumber();

                parsedEvents.push(new InitializeEvent<SolanaSwapData>(
                    paymentHash.toString("hex"),
                    txoHash.toString("hex"),
                    0,
                    swapData
                ));
            }
        }

        for(let listener of this.listeners) {
            await listener(parsedEvents);
        }
    }

    private eventListeners: number[] = [];
    private signaturesProcessing: {
        [signature: string]: {
            promise: Promise<boolean>,
            timeout: NodeJS.Timeout
        }
    } = {};

    private async fetchTxAndProcessEvent(signature: string): Promise<boolean> {
        try {
            // const result = await this.signer.connection.confirmTransaction(signature);
            // if(result.value.err!=null) {
            //     return true;
            // }
            const transaction = await this.signer.connection.getTransaction(signature, {
                commitment: "confirmed"
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
                    instructions
                });
            }
        } catch (e) {
            console.error(e);
            return false;
        }
        return true;
    }

    private setupWebsocket() {
        const eventCallback = (event, slotNumber, signature) => {
            if(this.signaturesProcessing[signature]!=null) return;

            console.log("[Solana Events WebSocket] Process signature: ", signature);

            const obj: {
                promise: Promise<boolean>,
                timeout: NodeJS.Timeout
            } = {
                promise: null,
                timeout: null
            };

            obj.promise = this.fetchTxAndProcessEvent(signature).then(result => {
                if(!result && this.wsTxFetchRetryTimeout!==0) {
                    obj.promise = null;
                    obj.timeout = setTimeout(() => {
                        console.log("[Solana Events WebSocket] Tx not found, retry in "+this.wsTxFetchRetryTimeout+"ms: ", signature);
                        obj.timeout = null;
                        obj.promise = this.fetchTxAndProcessEvent(signature);
                    }, this.wsTxFetchRetryTimeout);
                }
                return result;
            });

            this.signaturesProcessing[signature] = obj;

        };

        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("InitializeEvent", eventCallback));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("ClaimEvent", eventCallback));
        this.eventListeners.push(this.solanaSwapProgram.program.addEventListener("RefundEvent", eventCallback));

    }

    private async checkEvents() {
        const lastSignature = await this.getLastSignature();

        let signatures = null;

        if(lastSignature==null) {
            signatures = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                limit: 1
            }, "confirmed");
            if(signatures.length>0) {
                await this.saveLastSignature(signatures[0].signature);
            }
            return;
        }

        let fetched = null;
        while(fetched==null || fetched.length===this.logFetchLimit) {
            if(signatures==null) {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                    until: lastSignature,
                    limit: this.logFetchLimit
                }, "confirmed");
            } else {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                    before: signatures[signatures.length-1].signature,
                    until: lastSignature,
                    limit: this.logFetchLimit
                }, "confirmed");
            }
            if(signatures==null) {
                signatures = fetched;
            } else {
                fetched.forEach(e => signatures.push(e));
            }
        }

        let lastSuccessfulSignature = null;

        try {
            for(let i=signatures.length-1;i>=0;i--) {
                const txSignature = signatures[i].signature;

                const signatureHandlerObj: {
                    promise: Promise<boolean>,
                    timeout: NodeJS.Timeout
                } = this.signaturesProcessing[txSignature];
                if(signatureHandlerObj!=null) {
                    if(signatureHandlerObj.promise!=null) {
                        if(await signatureHandlerObj.promise) {
                            lastSuccessfulSignature = txSignature;
                            delete this.signaturesProcessing[txSignature];
                            continue;
                        }
                    }
                    if(signatureHandlerObj.timeout!=null) {
                        clearTimeout(signatureHandlerObj.timeout);
                    }
                    delete this.signaturesProcessing[txSignature];
                }

                console.log("[Solana Events POLL] Process signature: ", txSignature);

                const processPromise: Promise<boolean> = this.fetchTxAndProcessEvent(signatures[i].signature);
                this.signaturesProcessing[txSignature] = {
                    promise: processPromise,
                    timeout: null
                };
                await processPromise;
            }
        } catch (e) {
            console.error(e);
        }

        if(lastSuccessfulSignature!=null) {
            await this.saveLastSignature(lastSuccessfulSignature);
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
