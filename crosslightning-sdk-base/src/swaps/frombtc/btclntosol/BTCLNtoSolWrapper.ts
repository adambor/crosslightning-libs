import {BTCLNtoSolSwap} from "./BTCLNtoSolSwap";
import {IBTCxtoSolWrapper} from "../IBTCxtoSolWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import {ClientSwapContract, PaymentAuthError} from "../../ClientSwapContract";
import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {ChainEvents, ChainSwapType, ClaimEvent, InitializeEvent,
    RefundEvent,
    SignatureVerificationError,
    SwapCommitStatus, SwapData, SwapEvent, TokenAddress} from "crosslightning-base";

export class BTCLNtoSolWrapper<T extends SwapData> extends IBTCxtoSolWrapper<T> {

    listener: (events: SwapEvent<T>[]) => Promise<boolean>;

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     * @param swapDataDeserializer      Deserializer for SwapData
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>, swapDataDeserializer: new (data: any) => T) {
        super(storage, contract, chainEvents, swapDataDeserializer);
    }

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     * @param requiredToken     Token that we want to receive
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     */
    async create(amount: BN, expirySeconds: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<BTCLNtoSolSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveLightning(amount, expirySeconds, url, requiredToken, requiredBaseFee, requiredFeePPM);

        const parsed = bolt11.decode(result.pr);

        const swapData: T = await this.contract.swapContract.createSwapData(
            ChainSwapType.HTLC,
            requiredKey || result.intermediaryKey,
            this.contract.swapContract.getAddress(),
            requiredToken,
            null,
            parsed.tagsObject.payment_hash,
            null,
            null,
            null,
            false,
            true,
            result.securityDeposit,
            new BN(0)
        );

        const total = result.total;

        if(requiredKey!=null) {
            const liquidity = await this.contract.swapContract.getIntermediaryBalance(requiredKey, requiredToken);
            if(liquidity.lt(total)) {
                throw new IntermediaryError("Intermediary doesn't have enough liquidity");
            }
        }

        const swap = new BTCLNtoSolSwap<T>(this, result.pr, result.secret, url, swapData, result.swapFee, requiredBaseFee, requiredFeePPM, total, null, null);

        await swap.save();
        this.swapData[swap.getPaymentHash().toString("hex")] = swap;

        return swap;

    }

    /**
     * Returns a newly created swap, receiving 'amount' from the lnurl-withdraw
     *
     * @param lnurl             LNURL-withdraw to withdraw funds from
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     * @param requiredToken     Token that we want to receive
     * @param requiredKey       Required key of the Intermediary
     * @param requiredBaseFee   Desired base fee reported by the swap intermediary
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     */
    async createViaLNURL(lnurl: string, amount: BN, expirySeconds: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN): Promise<BTCLNtoSolSwap<T>> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveLightningLNURL(lnurl, amount, expirySeconds, url, requiredToken, requiredBaseFee, requiredFeePPM);

        const parsed = bolt11.decode(result.pr);

        const swapData: T = await this.contract.swapContract.createSwapData(
            ChainSwapType.HTLC,
            requiredKey || result.intermediaryKey,
            this.contract.swapContract.getAddress(),
            requiredToken,
            null,
            parsed.tagsObject.payment_hash,
            null,
            null,
            null,
            false,
            true,
            result.securityDeposit,
            new BN(0)
        );

        const total = result.total;

        if(requiredKey!=null) {
            const liquidity = await this.contract.swapContract.getIntermediaryBalance(requiredKey, requiredToken);
            if(liquidity.lt(total)) {
                throw new IntermediaryError("Intermediary doesn't have enough liquidity");
            }
        }

        const swap = new BTCLNtoSolSwap<T>(this, result.pr, result.secret, url, swapData, result.swapFee, requiredBaseFee, requiredFeePPM, total, lnurl, result.lnurlCallbackResult);

        await swap.save();
        this.swapData[swap.getPaymentHash().toString("hex")] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        console.log("Deserializers: ", SwapData.deserializers);

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<BTCLNtoSolSwap<T>>(this, BTCLNtoSolSwap);

        console.log("Swap data loaded");

        const processEvent = async (events: SwapEvent<T>[]) => {


            for(let event of events) {
                const paymentHash = event.paymentHash;

                console.log("Event payment hash: ", paymentHash);

                const swap: BTCLNtoSolSwap<T> = this.swapData[paymentHash] as BTCLNtoSolSwap<T>;

                console.log("Swap found: ", swap);

                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED) {
                        swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED || swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                        swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED || swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                        swap.state = BTCxtoSolSwapState.FAILED;
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

        console.log("Loaded FromBTCLN: ", this.swapData);

        const processSwap: (swap: BTCLNtoSolSwap<T>) => Promise<boolean> = async (swap: BTCLNtoSolSwap<T>) => {
            if(swap.state===BTCxtoSolSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.pr, swap.url, swap.data.getToken(), swap.data.getOfferer(), swap.requiredBaseFee, swap.requiredFeePPM);
                    if(res.is_paid) {
                        swap.state = BTCxtoSolSwapState.PR_PAID;

                        swap.data = res.data;
                        swap.prefix = res.prefix;
                        swap.timeout = res.timeout;
                        swap.signature = res.signature;

                        swap.expiry = res.expiry;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                    if(e instanceof PaymentAuthError) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        return true;
                    }
                }
                return false;
            }

            if(swap.state===BTCxtoSolSwapState.PR_PAID) {
                //Check if it's already committed
                try {
                    const status = await this.contract.swapContract.getCommitStatus(swap.data);
                    if(status===SwapCommitStatus.PAID) {
                        swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(status===SwapCommitStatus.EXPIRED) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        return true;
                    }
                    if(status===SwapCommitStatus.COMMITED) {
                        swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                }

                try {
                    await this.contract.swapContract.isValidInitAuthorization(swap.data, swap.timeout, swap.prefix, swap.signature, swap.nonce);
                } catch (e) {
                    console.error(e);
                    if(e instanceof SignatureVerificationError) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        return true;
                    }
                }

                return false;
            }

            if(swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                try {
                    const commitStatus = await this.contract.swapContract.getCommitStatus(swap.data);
                    if(commitStatus===SwapCommitStatus.PAID) {
                        swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                }
                return false;
            }
        };

        let promises = [];
        for(let paymentHash in this.swapData) {
            const swap: BTCLNtoSolSwap<T> = this.swapData[paymentHash] as BTCLNtoSolSwap<T>;

            promises.push(processSwap(swap).then(changed => {
                if(changed) changedSwaps[paymentHash] = true;
            }));
            if(promises.length>=this.MAX_CONCURRENT_REQUESTS) {
                await Promise.all(promises);
                promises = [];
            }
        }
        if(promises.length>0) await Promise.all(promises);

        console.log("Swap data checked");

        for(let event of eventQueue) {
            await processEvent([event]);
        }

        eventQueue = null;

        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => this.swapData[e]));

        this.isInitialized = true;
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<BTCLNtoSolSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            const castedSwap = swap as BTCLNtoSolSwap<T>;

            if(castedSwap.state===BTCxtoSolSwapState.PR_CREATED || castedSwap.state===BTCxtoSolSwapState.CLAIM_CLAIMED || castedSwap.state===BTCxtoSolSwapState.FAILED) {
                continue;
            }

            returnArr.push(castedSwap);
        }

        return returnArr;

    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwapsSync(): BTCLNtoSolSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            const castedSwap = swap as BTCLNtoSolSwap<T>;

            if(castedSwap.state===BTCxtoSolSwapState.PR_CREATED || castedSwap.state===BTCxtoSolSwapState.CLAIM_CLAIMED || castedSwap.state===BTCxtoSolSwapState.FAILED) {
                continue;
            }

            returnArr.push(castedSwap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<BTCLNtoSolSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap as BTCLNtoSolSwap<T>);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): BTCLNtoSolSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap as BTCLNtoSolSwap<T>);
        }

        return returnArr;

    }

    stop(): Promise<void> {
        this.chainEvents.unregisterListener(this.listener);
        return super.stop();
    }

}
