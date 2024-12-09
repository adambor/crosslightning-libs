import {SolanaModule} from "../SolanaModule";
import {ConfirmedSignatureInfo, PublicKey} from "@solana/web3.js";
import {log} from "node:util";

export class SolanaEvents extends SolanaModule {

    public readonly LOG_FETCH_LIMIT = 500;

    /**
     * Gets the signatures for a given topicKey public key, if lastProcessedSignature is specified, it fetches only
     *  the signatures before this signature
     *
     * @param topicKey
     * @param logFetchLimit
     * @param lastProcessedSignature
     * @private
     */
    private getSignatures(topicKey: PublicKey, logFetchLimit: number, lastProcessedSignature?: string): Promise<ConfirmedSignatureInfo[]> {
        if(lastProcessedSignature==null) {
            return this.connection.getSignaturesForAddress(topicKey, {
                limit: logFetchLimit,
            }, "confirmed");
        } else {
            return this.connection.getSignaturesForAddress(topicKey, {
                before: lastProcessedSignature,
                limit: logFetchLimit
            }, "confirmed");
        }
    }

    /**
     * Runs a search backwards in time, processing transaction signatures for a specific topic public key
     *
     * @param topicKey
     * @param processor called for every batch of returned signatures, should return a value if the correct signature
     *  was found, or null if the search should continue
     * @param abortSignal
     * @param logFetchLimit
     */
    public async findInSignatures<T>(
        topicKey: PublicKey,
        processor: (signatures: ConfirmedSignatureInfo[]) => Promise<T>,
        abortSignal?: AbortSignal,
        logFetchLimit?: number
    ): Promise<T> {
        if(logFetchLimit==null || logFetchLimit>this.LOG_FETCH_LIMIT) logFetchLimit = this.LOG_FETCH_LIMIT;
        let signatures: ConfirmedSignatureInfo[] = null;
        while(signatures==null || signatures.length>0) {
            signatures = await this.getSignatures(topicKey, logFetchLimit, signatures!=null ? signatures[signatures.length-1].signature : null);
            if(abortSignal!=null) abortSignal.throwIfAborted();
            const result: T = await processor(signatures);
            if(result!=null) return result;
            if(signatures.length<logFetchLimit) break;
        }
        return null;
    }

}