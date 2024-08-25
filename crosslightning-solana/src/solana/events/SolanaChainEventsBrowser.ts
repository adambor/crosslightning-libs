import {ChainEvents, ClaimEvent, EventListener, InitializeEvent, RefundEvent, SwapEvent} from "crosslightning-base";
import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {AnchorProvider, IdlEvents} from "@coral-xyz/anchor";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import {
    getLogger,
    onceAsync, tryWithRetries
} from "../../utils/Utils";
import {ParsedTransactionWithMeta, PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import {SwapTypeEnum} from "../swaps/SwapTypeEnum";
import {
    InstructionWithAccounts,
    ProgramEvent,
    SingleInstructionWithAccounts
} from "../program/modules/SolanaProgramEvents";
import {SwapProgram} from "../swaps/programTypes";

export type EventObject = {
    events: ProgramEvent<SwapProgram>[],
    instructions: InstructionWithAccounts<SwapProgram>[],
    blockTime: number,
    signature: string
};

export type InitInstruction = SingleInstructionWithAccounts<SwapProgram["instructions"][2 | 3], SwapProgram>;

/**
 * Solana on-chain event handler for front-end systems without access to fs, uses pure WS to subscribe, might lose
 *  out on some events if the network is unreliable, front-end systems should take this into consideration and not
 *  rely purely on events
 */
export class SolanaChainEventsBrowser implements ChainEvents<SolanaSwapData> {

    protected readonly listeners: EventListener<SolanaSwapData>[] = [];
    protected readonly provider: AnchorProvider;
    protected readonly solanaSwapProgram: SolanaSwapProgram;
    protected eventListeners: number[] = [];
    protected readonly logger = getLogger("SolanaChainEventsBrowser: ");

    constructor(provider: AnchorProvider, solanaSwapContract: SolanaSwapProgram) {
        this.provider = provider;
        this.solanaSwapProgram = solanaSwapContract;
    }

    /**
     * Fetches and parses transaction instructions
     *
     * @private
     * @returns {Promise<InstructionWithAccounts<SwapProgram>[]>} array of parsed instructions
     */
    private async getTransactionInstructions(signature: string): Promise<InstructionWithAccounts<SwapProgram>[]> {
        const transaction = await tryWithRetries<ParsedTransactionWithMeta>(async () => {
            const res = await this.provider.connection.getParsedTransaction(signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0
            });
            if(res==null) throw new Error("Transaction not found!");
            return res;
        });
        if(transaction==null) return null;
        if(transaction.meta.err!=null) return null;
        return this.solanaSwapProgram.Events.decodeInstructions(transaction.transaction.message);
    }

    /**
     * Converts initialize instruction data into {SolanaSwapData}
     *
     * @param initIx
     * @param txoHash
     * @private
     * @returns {SolanaSwapData} converted and parsed swap data
     */
    private instructionToSwapData(
        initIx: InitInstruction,
        txoHash: string
    ): SolanaSwapData {
        const paymentHash: Buffer = Buffer.from(initIx.data.swapData.hash);
        let securityDeposit: BN = new BN(0);
        let claimerBounty: BN = new BN(0);
        let payIn: boolean = true;
        if(initIx.name === "offererInitialize") {
            payIn = false;
            securityDeposit = initIx.data.securityDeposit;
            claimerBounty = initIx.data.claimerBounty;
        }

        return new SolanaSwapData(
            initIx.accounts.offerer,
            initIx.accounts.claimer,
            initIx.accounts.mint,
            initIx.data.swapData.amount,
            paymentHash.toString("hex"),
            initIx.data.swapData.sequence,
            initIx.data.swapData.expiry,
            initIx.data.swapData.nonce,
            initIx.data.swapData.confirmations,
            initIx.data.swapData.payOut,
            SwapTypeEnum.toNumber(initIx.data.swapData.kind),
            payIn,
            initIx.name === "offererInitializePayIn" ? initIx.accounts.offererAta : PublicKey.default,
            initIx.data.swapData.payOut ? initIx.accounts.claimerAta : PublicKey.default,
            securityDeposit,
            claimerBounty,
            txoHash
        );
    }

    /**
     * Returns async getter for fetching on-demand initialize event swap data
     *
     * @param eventObject
     * @param txoHash
     * @private
     * @returns {() => Promise<SolanaSwapData>} getter to be passed to InitializeEvent constructor
     */
    private getSwapDataGetter(eventObject: EventObject, txoHash: string): () => Promise<SolanaSwapData> {
        return async () => {
            if(eventObject.instructions==null) eventObject.instructions = await this.getTransactionInstructions(eventObject.signature);
            if(eventObject.instructions==null) return null;

            const initIx = eventObject.instructions.find(
                ix => ix!=null && (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
            ) as InitInstruction;
            if(initIx == null) return null;

            return this.instructionToSwapData(initIx, txoHash);
        }
    }

    protected parseInitializeEvent(data: IdlEvents<SwapProgram>["InitializeEvent"], eventObject: EventObject): InitializeEvent<SolanaSwapData> {
        const paymentHash: string = Buffer.from(data.hash).toString("hex");
        const txoHash: string = Buffer.from(data.txoHash).toString("hex");
        this.logger.debug("InitializeEvent paymentHash: "+paymentHash+" sequence: "+data.sequence.toString(10)+" txoHash: "+txoHash);
        return new InitializeEvent<SolanaSwapData>(
            paymentHash,
            data.sequence,
            txoHash,
            SwapTypeEnum.toChainSwapType(data.kind),
            onceAsync<SolanaSwapData>(this.getSwapDataGetter(eventObject, txoHash))
        );
    }

    protected parseRefundEvent(data: IdlEvents<SwapProgram>["RefundEvent"]): RefundEvent<SolanaSwapData> {
        const paymentHash: string = Buffer.from(data.hash).toString("hex");
        this.logger.debug("RefundEvent paymentHash: "+paymentHash+" sequence: "+data.sequence.toString(10));
        return new RefundEvent<SolanaSwapData>(paymentHash, data.sequence);
    }

    protected parseClaimEvent(data: IdlEvents<SwapProgram>["ClaimEvent"]): ClaimEvent<SolanaSwapData> {
        const secret: string = Buffer.from(data.secret).toString("hex");
        const paymentHash: string = Buffer.from(data.hash).toString("hex");
        this.logger.debug("ClaimEvent paymentHash: "+paymentHash+" sequence: "+data.sequence.toString(10)+" secret: "+secret);
        return new ClaimEvent<SolanaSwapData>(paymentHash, data.sequence, secret);
    }

    /**
     * Processes event as received from the chain, parses it & calls event listeners
     *
     * @param eventObject
     * @protected
     */
    protected async processEvent(eventObject : EventObject) {
        let parsedEvents: SwapEvent<SolanaSwapData>[] = eventObject.events.map(event => {
            let parsedEvent: SwapEvent<SolanaSwapData>;
            switch(event.name) {
                case "ClaimEvent":
                    parsedEvent = this.parseClaimEvent(event.data);
                    break;
                case "RefundEvent":
                    parsedEvent = this.parseRefundEvent(event.data);
                    break;
                case "InitializeEvent":
                    parsedEvent = this.parseInitializeEvent(event.data, eventObject);
                    break;
            }
            (parsedEvent as any).meta = {
                timestamp: eventObject.blockTime,
                txId: eventObject.signature
            };
            return parsedEvent;
        }).filter(parsedEvent => parsedEvent!=null);

        for(let listener of this.listeners) {
            await listener(parsedEvents);
        }
    }

    /**
     * Returns websocket event handler for specific event type
     *
     * @param name
     * @protected
     * @returns event handler to be passed to program's addEventListener function
     */
    protected getWsEventHandler<E extends "InitializeEvent" | "RefundEvent" | "ClaimEvent">(
        name: E
    ): (data: IdlEvents<SwapProgram>[E], slotNumber: number, signature: string) => void {
        return (data: IdlEvents<SwapProgram>[E], slotNumber: number, signature: string) => {
            this.logger.debug("wsEventHandler: Process signature: ", signature);

            this.processEvent({
                events: [{name, data: data as any}],
                instructions: null, //Instructions will be fetched on-demand if required
                blockTime: Math.floor(Date.now()/1000),
                signature
            }).then(() => true).catch(e => {
                console.error(e);
                return false;
            });
        };
    }

    /**
     * Sets up event handlers listening for swap events over websocket
     *
     * @protected
     */
    protected setupWebsocket() {
        const program = this.solanaSwapProgram.program;
        this.eventListeners.push(program.addEventListener<"InitializeEvent">("InitializeEvent", this.getWsEventHandler("InitializeEvent")));
        this.eventListeners.push(program.addEventListener<"ClaimEvent">("ClaimEvent", this.getWsEventHandler("ClaimEvent")));
        this.eventListeners.push(program.addEventListener<"RefundEvent">("RefundEvent", this.getWsEventHandler("RefundEvent")));
    }

    init(): Promise<void> {
        this.setupWebsocket();
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
