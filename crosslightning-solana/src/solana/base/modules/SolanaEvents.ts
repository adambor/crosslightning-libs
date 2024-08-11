import {SolanaModule} from "../SolanaModule";
import {ConfirmedSignatureInfo, PublicKey} from "@solana/web3.js";

export class SolanaEvents extends SolanaModule {

    public readonly LOG_FETCH_LIMIT = 500;

    /**
     * Gets the signatures for a given topicKey public key, if lastProcessedSignature is specified, it fetches only
     *  the signatures before this signature
     *
     * @param topicKey
     * @param lastProcessedSignature
     * @private
     */
    private getSignatures(topicKey: PublicKey, lastProcessedSignature?: string): Promise<ConfirmedSignatureInfo[]> {
        if(lastProcessedSignature==null) {
            return this.provider.connection.getSignaturesForAddress(topicKey, {
                limit: this.LOG_FETCH_LIMIT,
            }, "confirmed");
        } else {
            return this.provider.connection.getSignaturesForAddress(topicKey, {
                before: lastProcessedSignature,
                limit: this.LOG_FETCH_LIMIT
            }, "confirmed");
        }
    }

    public async findInSignatures<T>(
        topicKey: PublicKey,
        processor: (signatures: ConfirmedSignatureInfo[]) => Promise<T>,
        abortSignal?: AbortSignal
    ): Promise<T> {
        let signatures: ConfirmedSignatureInfo[] = null;
        while(signatures==null || signatures.length>0) {
            signatures = await this.getSignatures(topicKey, signatures!=null ? signatures[signatures.length-1].signature : null);
            if(abortSignal!=null) abortSignal.throwIfAborted();
            const result: T = await processor(signatures);
            if(result!=null) result;
        }
        return null;
    }

}