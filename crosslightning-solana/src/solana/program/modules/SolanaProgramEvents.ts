import {SolanaEvents} from "../../base/modules/SolanaEvents";
import {BorshCoder, DecodeType, Event, EventParser, Idl, IdlEvents, IdlTypes, Instruction} from "@coral-xyz/anchor";
import {IdlEvent, IdlField, IdlInstruction} from "@coral-xyz/anchor/dist/cjs/idl";
import {ConfirmedSignatureInfo, ParsedMessage, PartiallyDecodedInstruction, PublicKey} from "@solana/web3.js";
import {SolanaProgramBase} from "../SolanaProgramBase";

type DecodedFieldOrNull<D, Defined> = D extends IdlField ? DecodeType<D["type"], Defined> : unknown;
type ArgsTuple<A extends IdlField[], Defined> = {
    [K in A[number]["name"]]: DecodedFieldOrNull<Extract<A[number], { name: K }>, Defined>
};

export type InstructionWithAccounts<IDL extends Idl> = SingleInstructionWithAccounts<IDL["instructions"][number], IDL>;

export type SingleInstructionWithAccounts<I extends IdlInstruction, IDL extends Idl> = {
    name: I["name"],
    accounts: {
        [key in I["accounts"][number]["name"]]: PublicKey
    },
    data: ArgsTuple<I["args"], IdlTypes<IDL>>
};

export type ProgramEvent<IDL extends Idl> = Event<IDL["events"][number], Record<string, any>>;

export class SolanaProgramEvents<IDL extends Idl> extends SolanaEvents {

    private readonly programCoder: BorshCoder;
    private readonly eventParser: EventParser;
    readonly root: SolanaProgramBase<any>;
    private readonly nameMappedInstructions: {[name: string]: IdlInstruction};

    constructor(root: SolanaProgramBase<IDL>) {
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
    private async getEvents(signature: string): Promise<ProgramEvent<IDL>[]> {
        const tx = await this.provider.connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });
        if(tx.meta.err) return [];

        const events = this.parseLogs(tx.meta.logMessages);
        events.reverse();

        return events;
    }

    /**
     * Runs a search backwards in time, processing the events for a specific topic public key
     *
     * @param topicKey
     * @param processor called for every event, should return a value if the correct event was found, or null
     *  if the search should continue
     * @param abortSignal
     */
    public findInEvents<T>(
        topicKey: PublicKey,
        processor: (event: ProgramEvent<IDL>) => Promise<T>,
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

    /**
     * Decodes the instructions for this program from the transaction, leaves null in the returned instructions array
     *  for every instruction that doesn't correspond to this program (as those are impossible to parse)
     *
     * @param transactionMessage
     */
    public decodeInstructions(transactionMessage: ParsedMessage): InstructionWithAccounts<IDL>[] {
        const instructions: InstructionWithAccounts<IDL>[] = [];

        for(let _ix of transactionMessage.instructions) {
            if(!_ix.programId.equals(this.root.program.programId)) {
                instructions.push(null);
                continue;
            }

            const ix: PartiallyDecodedInstruction = _ix as PartiallyDecodedInstruction;
            if(ix.data==null) continue;

            const parsedIx: Instruction = this.programCoder.instruction.decode(ix.data, 'base58');
            const accountsData = this.nameMappedInstructions[parsedIx.name];
            let accounts: {[name: string]: PublicKey};
            if(accountsData!=null && accountsData.accounts!=null) {
                accounts = {};
                for(let i=0;i<accountsData.accounts.length;i++) {
                    accounts[accountsData.accounts[i].name] = ix.accounts[i];
                }
            }
            instructions.push({
                name: parsedIx.name,
                data: parsedIx.data as any,
                accounts: accounts as any
            });
        }

        return instructions;
    }

    /**
     * Parses program event related to this program from transaction logs
     *
     * @param logs
     */
    public parseLogs(logs: string[]): ProgramEvent<IDL>[] {
        const eventsGenerator = this.eventParser.parseLogs(logs);

        const events: ProgramEvent<IDL>[] = [];
        for(let log of eventsGenerator) {
            events.push(log as ProgramEvent<IDL>);
        }

        return events;
    }

}