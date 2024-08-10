import {AnchorProvider, BorshCoder, Event, EventParser, Program} from "@coral-xyz/anchor";
import {SolanaFeeEstimator} from "../utils/SolanaFeeEstimator";
import {ConfirmedSignatureInfo, PublicKey} from "@solana/web3.js";
import {IdlEvent} from "@coral-xyz/anchor/dist/cjs/idl";

const LOG_FETCH_LIMIT = 500;

export class SolanaProgramBase {

    provider: AnchorProvider;
    programCoder: BorshCoder;
    program: Program;
    eventParser: EventParser;

    solanaFeeEstimator: SolanaFeeEstimator;

    constructor(
        provider: AnchorProvider,
        programIdl: any,
        programAddress?: string,
        solanaFeeEstimator: SolanaFeeEstimator = new SolanaFeeEstimator(provider.connection)
    ) {
        this.provider = provider;
        this.programCoder = new BorshCoder(programIdl as any);
        this.program = new Program(programIdl as any, programAddress || programIdl.metadata.address, provider);
        this.eventParser = new EventParser(this.program.programId, this.programCoder);

        this.solanaFeeEstimator = solanaFeeEstimator;
    }

    /**
     * Gets the signatures for a given topicKey public key, if lastProcessedSignature is specified, it fetches only
     *  the signatures before this signature
     *
     * @param topicKey
     * @param lastProcessedSignature
     * @private
     */
    protected getSignatures(topicKey: PublicKey, lastProcessedSignature?: string): Promise<ConfirmedSignatureInfo[]> {
        if(lastProcessedSignature==null) {
            return this.provider.connection.getSignaturesForAddress(topicKey, {
                limit: LOG_FETCH_LIMIT
            }, "confirmed");
        } else {
            return this.provider.connection.getSignaturesForAddress(topicKey, {
                before: lastProcessedSignature,
                limit: LOG_FETCH_LIMIT
            }, "confirmed");
        }
    }

    protected async findInSignatures<T>(
        topicKey: PublicKey,
        processor: (signatures: ConfirmedSignatureInfo[]) => Promise<T>
    ): Promise<T> {
        let signatures: ConfirmedSignatureInfo[] = null;
        while(signatures==null || signatures.length>0) {
            signatures = await this.getSignatures(topicKey, signatures!=null ? signatures[signatures.length-1].signature : null);
            const result: T = await processor(signatures);
            if(result!=null) result;
        }
        return null;
    }

    /**
     * Gets events from specific transaction as specified by signature, events are ordered from newest to oldest
     *
     * @param signature
     * @private
     */
    protected async getEvents(signature: string): Promise<Event<IdlEvent, Record<string, any>>[]> {
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

    protected findInEvents<T>(
        topicKey: PublicKey,
        processor: (event: Event<IdlEvent, Record<string, any>>) => Promise<T>
    ): Promise<T> {
        return this.findInSignatures<T>(topicKey, async (signatures: ConfirmedSignatureInfo[]) => {
            for(let data of signatures) {
                for(let event of await this.getEvents(data.signature)) {
                    const result: T = await processor(event);
                    if(result!=null) return result;
                }
            }
        });
    }

}