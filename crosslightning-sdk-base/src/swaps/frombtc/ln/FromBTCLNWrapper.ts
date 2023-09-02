import {FromBTCLNSwap, FromBTCLNSwapState} from "./FromBTCLNSwap";
import {IFromBTCWrapper} from "../IFromBTCWrapper";
import {IWrapperStorage} from "../../../storage/IWrapperStorage";
import {ClientSwapContract, PaymentAuthError} from "../../ClientSwapContract";
import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SignatureVerificationError,
    SwapCommitStatus,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";

export class FromBTCLNWrapper<T extends SwapData> extends IFromBTCWrapper<T> {

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
     * @param requiredFeePPM    Desired proportional fee report by the swap intermediary
     * @param exactOut          Whether to create an exact out swap instead of exact in
     */
    async create(amount: BN, expirySeconds: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN, exactOut?: boolean): Promise<FromBTCLNSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveLightning(amount, expirySeconds, url, requiredToken, requiredBaseFee, requiredFeePPM, exactOut);

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

        const swap = new FromBTCLNSwap<T>(this, result.pr, result.secret, url, swapData, result.swapFee, requiredBaseFee, requiredFeePPM, total, null, null, null, null, null);

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
     * @param noInstantReceive  Flag to disable instantly posting the lightning PR to LN service for withdrawal, when set the lightning PR is sent to LN service when waitForPayment is called
     */
    async createViaLNURL(lnurl: string, amount: BN, expirySeconds: number, url: string, requiredToken?: TokenAddress, requiredKey?: string, requiredBaseFee?: BN, requiredFeePPM?: BN, noInstantReceive?: boolean): Promise<FromBTCLNSwap<T>> {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveLightningLNURL(lnurl, amount, expirySeconds, url, requiredToken, requiredBaseFee, requiredFeePPM, noInstantReceive);

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

        const swap = new FromBTCLNSwap<T>(this, result.pr, result.secret, url, swapData, result.swapFee, requiredBaseFee, requiredFeePPM, total, lnurl, result.lnurlCallbackResult, result.withdrawRequest.k1, result.withdrawRequest.callback, !noInstantReceive);

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
        this.swapData = await this.storage.loadSwapData<FromBTCLNSwap<T>>(this, FromBTCLNSwap);

        console.log("Swap data loaded");

        const processEvent = async (events: SwapEvent<T>[]) => {


            for(let event of events) {
                const paymentHash = event.paymentHash;

                console.log("Event payment hash: ", paymentHash);

                const swap: FromBTCLNSwap<T> = this.swapData[paymentHash] as FromBTCLNSwap<T>;

                console.log("Swap found: ", swap);

                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.PR_CREATED) {
                        swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.PR_CREATED || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===FromBTCLNSwapState.PR_PAID || swap.state===FromBTCLNSwapState.PR_CREATED || swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                        swap.state = FromBTCLNSwapState.FAILED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        let promise: Promise<any>;
                        if(swap.state===FromBTCLNSwapState.EXPIRED) {
                            promise = this.storage.removeSwapData(swap)
                        } else {
                            promise = swap.save();
                        }
                        promise.then(() => {
                            swap.emitEvent();
                        });
                    }
                }
            }

            return true;

        };

        this.listener = (events: SwapEvent<T>[]) => {
            console.log("EVENT: ", events);

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

        const processSwap: (swap: FromBTCLNSwap<T>) => Promise<boolean> = async (swap: FromBTCLNSwap<T>) => {
            if(swap.state===FromBTCLNSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.pr, swap.url, swap.data.getToken(), swap.data.getOfferer(), swap.requiredBaseFee, swap.requiredFeePPM);
                    if(res.is_paid) {
                        swap.state = FromBTCLNSwapState.PR_PAID;

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
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                }
                return false;
            }

            if(swap.state===FromBTCLNSwapState.PR_PAID) {
                //Check if it's already committed
                try {
                    const status = await this.contract.swapContract.getCommitStatus(swap.data);
                    if(status===SwapCommitStatus.PAID) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(status===SwapCommitStatus.EXPIRED) {
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                    if(status===SwapCommitStatus.COMMITED) {
                        swap.state = FromBTCLNSwapState.CLAIM_COMMITED;
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
                        swap.state = FromBTCLNSwapState.EXPIRED;
                        return true;
                    }
                }

                return false;
            }

            if(swap.state===FromBTCLNSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                try {
                    const commitStatus = await this.contract.swapContract.getCommitStatus(swap.data);
                    if(commitStatus===SwapCommitStatus.PAID) {
                        swap.state = FromBTCLNSwapState.CLAIM_CLAIMED;
                        return true;
                    }
                    if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                        swap.state = FromBTCLNSwapState.FAILED;
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
            const swap: FromBTCLNSwap<T> = this.swapData[paymentHash] as FromBTCLNSwap<T>;

            promises.push(processSwap(swap).then(changed => {
                if(swap.state===FromBTCLNSwapState.EXPIRED) {
                    this.storage.removeSwapData(swap);
                } else {
                    if(changed) changedSwaps[paymentHash] = true;
                }
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
    getClaimableSwaps(): Promise<FromBTCLNSwap<T>[]> {
        return Promise.resolve(this.getClaimableSwapsSync());
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    getClaimableSwapsSync(): FromBTCLNSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: FromBTCLNSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            const castedSwap = swap as FromBTCLNSwap<T>;

            if(
                castedSwap.state===FromBTCLNSwapState.PR_CREATED ||
                castedSwap.state===FromBTCLNSwapState.CLAIM_CLAIMED ||
                castedSwap.state===FromBTCLNSwapState.FAILED ||
                castedSwap.state===FromBTCLNSwapState.EXPIRED
            ) {
                continue;
            }

            returnArr.push(castedSwap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<FromBTCLNSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: FromBTCLNSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap as FromBTCLNSwap<T>);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): FromBTCLNSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: FromBTCLNSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.swapContract.getAddress()) {
                continue;
            }

            returnArr.push(swap as FromBTCLNSwap<T>);
        }

        return returnArr;

    }

    stop(): Promise<void> {
        this.chainEvents.unregisterListener(this.listener);
        return super.stop();
    }

}
