import {SolanaModule} from "../SolanaModule";
import {Commitment, ParsedAccountsModeBlockResponse, PublicKey} from "@solana/web3.js";


export class SolanaSlots extends SolanaModule {

    public readonly SLOT_CACHE_SLOTS = 12;
    public readonly SLOT_CACHE_TIME = this.SLOT_CACHE_SLOTS*this.root.SLOT_TIME;

    private slotCache: {
        [key in Commitment]?: {
            slot: Promise<number>,
            timestamp: number
        }
    } = {};

    private fetchAndSaveSlot(commitment: Commitment): {slot: Promise<number>, timestamp: number} {
        const slotPromise = this.provider.connection.getSlot(commitment);
        const timestamp = Date.now();
        this.slotCache[commitment] = {
            slot: slotPromise,
            timestamp
        }
        slotPromise.catch(e => {
            if(this.slotCache[commitment]!=null && this.slotCache[commitment].slot===slotPromise) delete this.slotCache[commitment];
        })
        return {
            slot: slotPromise,
            timestamp
        }
    }

    ///////////////////
    //// Slots
    public async getCachedSlotAndTimestamp(commitment: Commitment): Promise<{
        slot: number,
        timestamp: number
    }> {
        let cachedSlotData = this.slotCache[commitment];

        if(cachedSlotData==null || Date.now()-cachedSlotData.timestamp>this.SLOT_CACHE_TIME) {
            cachedSlotData = this.fetchAndSaveSlot(commitment);
        }

        return {
            slot: await cachedSlotData.slot,
            timestamp: cachedSlotData.timestamp
        };
    }

    public async getCachedSlot(commitment: Commitment): Promise<number> {
        let cachedSlotData = this.slotCache[commitment];

        if(cachedSlotData!=null && Date.now()-cachedSlotData.timestamp<this.SLOT_CACHE_TIME) {
            return (await cachedSlotData.slot) + Math.floor((Date.now()-cachedSlotData.timestamp)/this.root.SLOT_TIME);
        }

        cachedSlotData = this.fetchAndSaveSlot(commitment);

        return await cachedSlotData.slot;
    }


}