import {ChainEvents, ClaimEvent, EventListener, InitializeEvent, RefundEvent, SwapEvent} from "crosslightning-base";
import {SolanaSwapData} from "../swaps/SolanaSwapData";
import {AnchorProvider} from "@coral-xyz/anchor";
import {SolanaSwapProgram} from "../swaps/SolanaSwapProgram";
import Utils, {
    IxWithAccounts,
    onceAsync,
    SolanaClaimEvent,
    SolanaInitializeEvent,
    SolanaRefundEvent
} from "../swaps/Utils";
import {tryWithRetries} from "../../utils/RetryUtils";
import {ParsedTransactionWithMeta, PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import {SwapTypeEnum} from "../swaps/SwapTypeEnum";
import {EventObject} from "./SolanaChainEvents";

export class SolanaChainEventsBrowser implements ChainEvents<SolanaSwapData> {

    protected readonly listeners: EventListener<SolanaSwapData>[] = [];
    protected readonly provider: AnchorProvider;
    protected readonly solanaSwapProgram: SolanaSwapProgram;
    protected eventListeners: number[] = [];

    constructor(provider: AnchorProvider, solanaSwapContract: SolanaSwapProgram) {
        this.provider = provider;
        this.solanaSwapProgram = solanaSwapContract;
    }

    /**
     * Fetches and parses transaction instructions
     *
     * @private
     * @returns {Promise<IxWithAccounts[]>} array of parsed instructions
     */
    private async getTransactionInstructions(signature: string): Promise<IxWithAccounts[]> {
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
        return Utils.decodeInstructions(transaction.transaction.message);
    }

    /**
     * Converts initialize instruction data into {SolanaSwapData}
     *
     * @param initIx
     * @param txoHash
     * @private
     * @returns {SolanaSwapData} converted and parsed swap data
     */
    private instructionToSwapData(initIx: IxWithAccounts, txoHash: number[]): SolanaSwapData {
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
            Buffer.from(txoHash).toString("hex")
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
    private getSwapDataGetter(eventObject: EventObject, txoHash: number[]): () => Promise<SolanaSwapData> {
        return async () => {
            if(eventObject.instructions==null) eventObject.instructions = await this.getTransactionInstructions(eventObject.signature);
            if(eventObject.instructions==null) return null;

            const initIx = eventObject.instructions.find(
                ix => ix.name === "offererInitializePayIn" || ix.name === "offererInitialize"
            )
            if(initIx == null) return null;

            return this.instructionToSwapData(initIx, txoHash);
        }
    }

    protected parseInitializeEvent(event: SolanaInitializeEvent, eventObject: EventObject): InitializeEvent<SolanaSwapData> {
        const paymentHash: Buffer = Buffer.from(event.data.hash);

        return new InitializeEvent<SolanaSwapData>(
            paymentHash.toString("hex"),
            event.data.sequence,
            Buffer.from(event.data.txoHash).toString("hex"),
            SwapTypeEnum.toChainSwapType(event.data.kind),
            onceAsync<SolanaSwapData>(this.getSwapDataGetter(eventObject, event.data.txoHash))
        );
    }

    protected parseRefundEvent(event: SolanaRefundEvent): RefundEvent<SolanaSwapData> {
        const paymentHash: Buffer = Buffer.from(event.data.hash);
        return new RefundEvent<SolanaSwapData>(paymentHash.toString("hex"), event.data.sequence);
    }

    protected parseClaimEvent(event: SolanaClaimEvent): ClaimEvent<SolanaSwapData> {
        const secret: Buffer = Buffer.from(event.data.secret);
        const paymentHash: Buffer = Buffer.from(event.data.hash);
        return new ClaimEvent<SolanaSwapData>(paymentHash.toString("hex"), event.data.sequence, secret.toString("hex"));
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
                    parsedEvent = this.parseClaimEvent(event as SolanaClaimEvent);
                    break;
                case "RefundEvent":
                    parsedEvent = this.parseRefundEvent(event as SolanaRefundEvent);
                    break;
                case "InitializeEvent":
                    parsedEvent = this.parseInitializeEvent(event as SolanaInitializeEvent, eventObject);
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
    protected getWsEventHandler(
        name: "InitializeEvent" | "RefundEvent" | "ClaimEvent"
    ): (data: any, slotNumber: number, signature: string) => void {
        return (data: any, slotNumber: number, signature: string) => {
            console.log("[Solana Events WebSocket] Process signature: ", signature);

            this.processEvent({
                events: [{name, data}],
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
        this.eventListeners.push(program.addEventListener("InitializeEvent", this.getWsEventHandler("InitializeEvent")));
        this.eventListeners.push(program.addEventListener("ClaimEvent", this.getWsEventHandler("ClaimEvent")));
        this.eventListeners.push(program.addEventListener("RefundEvent", this.getWsEventHandler("RefundEvent")));
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
