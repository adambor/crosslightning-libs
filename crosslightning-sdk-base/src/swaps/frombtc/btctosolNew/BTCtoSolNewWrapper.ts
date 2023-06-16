import {IBTCxtoSolWrapper} from "../IBTCxtoSolWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {BTCtoSolNewSwap, BTCtoSolNewSwapState} from "./BTCtoSolNewSwap";
import {ChainUtils} from "../../../btc/ChainUtils";
import {ClientSwapContract} from "../../ClientSwapContract";
import * as BN from "bn.js";
import {SignatureVerificationError, SwapCommitStatus, SwapData, TokenAddress, ClaimEvent, InitializeEvent,
    RefundEvent, SwapEvent, ChainEvents, RelaySynchronizer} from "crosslightning-base";
import {BTCLNtoSolSwap} from "../../..";

export class BTCtoSolNewWrapper<T extends SwapData> extends IBTCxtoSolWrapper<T> {

    synchronizer: RelaySynchronizer<any,any,any>;
    listener: (events: SwapEvent<T>[]) => Promise<boolean>;

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     * @param synchronizer      Btc relay synchronizer
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T, synchronizer: RelaySynchronizer<any,any,any>) {
        super(storage, contract, chainEvents, swapDataDeserializer);
        this.synchronizer = synchronizer;
    }

    /**
     * Returns a newly created swap, receiving 'amount' on chain
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param url               Intermediary/Counterparty swap service url
     * @param requiredToken     Token that we want to receive
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     */
    async create(amount: BN, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<BTCtoSolNewSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveOnchain(amount, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM);

        const swap = new BTCtoSolNewSwap(this, result.address, amount, url, result.data, result.swapFee, result.prefix, result.timeout, result.signature, result.nonce);

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<BTCtoSolNewSwap<T>>(this, BTCtoSolNewSwap);

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;
                console.log("Event payment hash: ", paymentHash);
                const swap: BTCtoSolNewSwap<T> = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

                console.log("Swap found: ", swap);
                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED) {
                        swap.state = BTCtoSolNewSwapState.CLAIM_COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                        swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                        swap.state = BTCtoSolNewSwapState.FAILED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        swap.save().then(() => {
                            swap.emitEvent();
                        });
                    }
                }
            }

            return true;

        };

        this.listener = (events: SwapEvent<T>[]) => {
            console.log("EVENT: ", event);

            if(eventQueue!=null) {
                for(let event of events) {
                    eventQueue.push(event);
                }
                return Promise.resolve(true);
            }

            return processEvent(events);
        };

        this.chainEvents.registerListener(this.listener);

        const changedSwaps = {};


        const processSwap: (swap: BTCtoSolNewSwap<T>) => Promise<boolean> = async (swap: BTCtoSolNewSwap<T>) => {
            if(swap.state===BTCtoSolNewSwapState.PR_CREATED) {
                const status = await this.contract.swapContract.getCommitStatus(swap.data);

                if(status===SwapCommitStatus.COMMITED) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_COMMITED;
                    //Check if payment already arrived
                    const tx = await ChainUtils.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx!=null && tx.tx.status.confirmed) {
                        const tipHeight = await ChainUtils.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.getConfirmations()) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
                        }
                    }
                    return true;
                }

                if(status===SwapCommitStatus.NOT_COMMITED) {
                    //Check if signature is still valid
                    try {
                        await this.contract.swapContract.isValidInitAuthorization(swap.data, swap.timeout, swap.prefix, swap.signature, swap.nonce);
                    } catch (e) {
                        if(e instanceof SignatureVerificationError) {
                            swap.state = BTCtoSolNewSwapState.FAILED;
                            return true;
                        }
                    }
                    return false;
                }

                if(status===SwapCommitStatus.EXPIRED) {
                    swap.state = BTCtoSolNewSwapState.FAILED;
                    return true;
                }

                if(status===SwapCommitStatus.PAID) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                    return true;
                }
            }

            if(swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.swapContract.getCommitStatus(swap.data);
                if(commitStatus===SwapCommitStatus.PAID) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                    return true;
                }
                if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                    swap.state = BTCtoSolNewSwapState.FAILED;
                    return true;
                }
                if(commitStatus===SwapCommitStatus.COMMITED) {
                    //Check if payment already arrived
                    const tx = await ChainUtils.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx!=null && tx.tx.status.confirmed) {
                        const tipHeight = await ChainUtils.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.getConfirmations()) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
                            return true;
                        }
                    }
                }
            }
        };

        let promises = [];
        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

            promises.push(processSwap(swap).then(changed => {
                if(changed) changedSwaps[paymentHash] = true;
            }));

            if(promises.length>=this.MAX_CONCURRENT_REQUESTS) {
                await Promise.all(promises);
                promises = [];
            }
        }

        if(promises.length>0) await Promise.all(promises);

        for(let event of eventQueue) {
            await processEvent([event]);
        }

        eventQueue = null;

        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => changedSwaps[e]));

        this.isInitialized = true;
    }


    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<BTCtoSolNewSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap: BTCtoSolNewSwap<T> = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.PR_CREATED && swap.txId==null) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.CLAIM_CLAIMED || swap.state===BTCtoSolNewSwapState.FAILED) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwapsSync(): BTCtoSolNewSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap: BTCtoSolNewSwap<T> = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.PR_CREATED && swap.txId==null) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.CLAIM_CLAIMED || swap.state===BTCtoSolNewSwapState.FAILED) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<BTCtoSolNewSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): BTCtoSolNewSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    stop(): Promise<void> {
        this.chainEvents.unregisterListener(this.listener);
        return super.stop();
    }

}
