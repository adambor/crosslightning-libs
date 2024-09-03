import {BitcoinRpc, BtcBlock, BtcTx} from "crosslightning-base";
import {Buffer} from "buffer";

export type BtcTxWithBlockheight = BtcTx & {
    blockheight?: number
};

export interface BitcoinRpcWithTxoListener<T extends BtcBlock> extends BitcoinRpc<T> {

    getTransaction(txId: string): Promise<BtcTxWithBlockheight>;

    /**
     * Checks if an address received the transaction with the required txoHash, returns info about that
     *  specific transaction if found, or null if not found
     *
     * @param address Address that should receive the transaction
     * @param txoHash Required output txoHash
     */
    checkAddressTxos(address: string, txoHash: Buffer): Promise<{
        tx: BtcTxWithBlockheight,
        vout: number
    } | null>;

    /**
     * Waits till the address receives a transaction containing a specific txoHash
     *
     * @param address Address that should receive the transaction
     * @param txoHash Required output txoHash
     * @param requiredConfirmations Required confirmations of the transaction
     * @param stateUpdateCbk Callback for transaction state updates
     * @param abortSignal Abort signal
     * @param intervalSeconds How often to check new transaction
     */
    waitForAddressTxo(
        address: string,
        txoHash: Buffer,
        requiredConfirmations: number,
        stateUpdateCbk:(confirmations: number, txId: string, vout: number, txEtaMS: number) => void,
        abortSignal?: AbortSignal,
        intervalSeconds?: number
    ): Promise<{
        tx: BtcTxWithBlockheight,
        vout: number
    }>;

}