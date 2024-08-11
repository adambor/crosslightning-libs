import {SolanaModule} from "../SolanaModule";
import {Commitment, ParsedAccountsModeBlockResponse, PublicKey} from "@solana/web3.js";


export class SolanaBlocks extends SolanaModule {

    private blockCache: Map<number, Promise<ParsedAccountsModeBlockResponse>> = new Map<number, Promise<ParsedAccountsModeBlockResponse>>();

    private fetchAndSaveParsedBlock(slot: number): Promise<ParsedAccountsModeBlockResponse> {
        const blockCacheData = this.provider.connection.getParsedBlock(slot, {
            transactionDetails: "none",
            commitment: "confirmed",
            rewards: false
        });
        this.blockCache.set(slot, blockCacheData);
        blockCacheData.catch(e => {
            if(this.blockCache.get(slot)==blockCacheData) this.blockCache.delete(slot);
        });
        return blockCacheData;
    }

    ///////////////////
    //// Blocks
    public async findLatestParsedBlock(commitment: Commitment): Promise<{
        block: ParsedAccountsModeBlockResponse,
        slot: number
    }> {
        let slot = await this.root.Slots.getCachedSlot(commitment);

        let error;
        for(let i=0;i<10;i++) {
            try {
                return {
                    block: await this.getParsedBlock(slot),
                    slot
                }
            } catch (e) {
                console.error(e);
                if(e.toString().startsWith("SolanaJSONRPCError: failed to get block: Block not available for slot")) {
                    slot--;
                    error = e;
                } else {
                    throw e;
                }
            }
        }

        throw error;
    }

    //Parsed block caching
    public async getParsedBlock(slot: number): Promise<ParsedAccountsModeBlockResponse> {
        let blockCacheData = this.blockCache.get(slot);
        if(blockCacheData==null) {
            blockCacheData = this.fetchAndSaveParsedBlock(slot);
        }
        return await blockCacheData;
    }

}