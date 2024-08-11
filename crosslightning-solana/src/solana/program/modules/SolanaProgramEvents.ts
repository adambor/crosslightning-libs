import {SolanaEvents} from "../../base/modules/SolanaEvents";
import {BorshCoder, Event, EventParser} from "@coral-xyz/anchor";
import {IdlEvent} from "@coral-xyz/anchor/dist/cjs/idl";
import {ConfirmedSignatureInfo, PublicKey} from "@solana/web3.js";
import {SolanaProgramBase} from "../SolanaProgramBase";

export class SolanaProgramEvents extends SolanaEvents {

    programCoder: BorshCoder;
    eventParser: EventParser;

    constructor(root: SolanaProgramBase<any>) {
        super(root);
        this.programCoder = new BorshCoder(root.program.idl);
        this.eventParser = new EventParser(root.program.programId, this.programCoder);
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
}