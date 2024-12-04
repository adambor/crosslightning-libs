import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData} from "crosslightning-base";
import {FromBtcBaseSwapHandler} from "./FromBtcBaseSwapHandler";
import * as BN from "bn.js";
import * as lncli from "ln-service";


export abstract class FromBtcLnBaseSwapHandler<V extends SwapHandlerSwap<SwapData, S>, S> extends FromBtcBaseSwapHandler<V, S> {

    /**
     * Checks if we have enough inbound liquidity to be able to receive an LN payment (without MPP)
     *
     * @param amountBD
     * @param channelsPrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there isn't enough inbound liquidity to receive the LN payment
     */
    protected async checkInboundLiquidity(amountBD: BN, channelsPrefetch: Promise<{channels: any[]}>, signal: AbortSignal) {
        const channelsResponse = await channelsPrefetch;

        signal.throwIfAborted();

        let hasEnoughInboundLiquidity = false;
        channelsResponse.channels.forEach(channel => {
            if(new BN(channel.remote_balance).gte(amountBD)) hasEnoughInboundLiquidity = true;
        });
        if(!hasEnoughInboundLiquidity) {
            throw {
                code: 20050,
                msg: "Not enough LN inbound liquidity"
            };
        }
    }

    /**
     * Starts LN channels pre-fetch
     *
     * @param abortController
     */
    protected getChannelsPrefetch(abortController: AbortController): Promise<{channels: any[]}> {
        return lncli.getChannels({is_active: true, lnd: this.LND}).catch(e => {
            this.logger.error("getChannelsPrefetch(): error", e);
            abortController.abort(e);
            return null;
        });
    }

}