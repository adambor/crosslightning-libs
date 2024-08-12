import {SolanaEvents} from "../../base/modules/SolanaEvents";
import {BorshCoder, Event, EventParser, Idl} from "@coral-xyz/anchor";
import {IdlEvent, IdlInstruction} from "@coral-xyz/anchor/dist/cjs/idl";
import {ConfirmedSignatureInfo, ParsedMessage, PartiallyDecodedInstruction, PublicKey} from "@solana/web3.js";
import {SolanaProgramBase} from "../SolanaProgramBase";
import {IxWithAccounts} from "../../swaps/SolanaSwapProgram";
import * as programIdl from "../../swaps/programIdl.json";

export class SolanaProgramEvents extends SolanaEvents {

    private readonly programCoder: BorshCoder;
    private readonly eventParser: EventParser;
    readonly root: SolanaProgramBase<any>;
    private readonly nameMappedInstructions: {[name: string]: IdlInstruction};

    constructor(root: SolanaProgramBase<Idl>) {
        super(root);
        this.root = root;
        this.programCoder = new BorshCoder(root.program.idl);
        this.eventParser = new EventParser(root.program.programId, this.programCoder);
        this.nameMappedInstructions = {};
        for(let ix of root.program.idl.instructions) {
            this.nameMappedInstructions[ix.name] = ix;
        }
    }

    /**
     * Gets events from specific transaction as specified by signature, events are ordered from newest to oldest
     *
     * @param signature
     * @private
     */
    private async getEvents(signature: string): Promise<Event<IdlEvent, Record<string, any>>[]> {
        const tx = await this.provider.connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(tx.meta.err) return [];

        const eventsGenerator = this.eventParser.parseLogs(tx.meta.logMessages);

        const events: Event<IdlEvent, Record<string, any>>[] = [];
        for(let log of eventsGenerator) {
            events.push(log);
        }
        events.reverse();

        return events;
    }

    public findInEvents<T>(
        topicKey: PublicKey,
        processor: (event: Event<IdlEvent, Record<string, any>>) => Promise<T>,
        abortSignal?: AbortSignal
    ): Promise<T> {
        return this.findInSignatures<T>(topicKey, async (signatures: ConfirmedSignatureInfo[]) => {
            for(let data of signatures) {
                for(let event of await this.getEvents(data.signature)) {
                    if(abortSignal!=null) abortSignal.throwIfAborted();
                    const result: T = await processor(event);
                    if(result!=null) return result;
                }
            }
        }, abortSignal);
    }

    public decodeInstructions(transactionMessage: ParsedMessage): IxWithAccounts[] {
        const instructions: IxWithAccounts[] = [];

        for(let _ix of transactionMessage.instructions) {
            if(!_ix.programId.equals(this.root.program.programId)) {
                instructions.push(null);
                continue;
            }

            const ix: PartiallyDecodedInstruction = _ix as PartiallyDecodedInstruction;
            if(ix.data==null) continue;

            const parsedIx: any = this.programCoder.instruction.decode(ix.data, 'base58');
            const accountsData = this.nameMappedInstructions[parsedIx.name];
            if(accountsData!=null && accountsData.accounts!=null) {
                parsedIx.accounts = {};
                for(let i=0;i<accountsData.accounts.length;i++) {
                    parsedIx.accounts[accountsData.accounts[i].name] = ix.accounts[i];
                }
            }
            instructions.push(parsedIx);
        }

        return instructions;
    }

}