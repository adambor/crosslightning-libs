import * as BN from "bn.js";
import {
    IStorageManager,
    SwapContract,
    SwapData,
} from "crosslightning-base";
import {EventEmitter} from "events";
import {LnForGasSwap, LnForGasSwapState} from "./LnForGasSwap";
import {RequestError} from "../../..";
import {PaymentAuthError} from "../../../errors/PaymentAuthError";
import {fetchWithTimeout, tryWithRetries} from "../../../utils/Utils";

export class LnForGasWrapper<T extends SwapData> {

    readonly events: EventEmitter = new EventEmitter();

    readonly MAX_CONCURRENT_REQUESTS: number = 10;

    readonly storage: IStorageManager<LnForGasSwap<T>>;
    readonly contract: SwapContract<T, any, any, any>;
    readonly options: {
        getRequestTimeout?: number,
        postRequestTimeout?: number
    };
    isInitialized: boolean = false;

    swaps: {
        [paymentHash: string]: LnForGasSwap<T>
    };

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param options           Options for post/get requests
     */
    constructor(
        storage: IStorageManager<LnForGasSwap<T>>,
        contract: SwapContract<T, any, any, any>,
        options: {
            getRequestTimeout?: number,
            postRequestTimeout?: number
        }
    ) {
        this.storage = storage;
        this.contract = contract;
        if(options.getRequestTimeout==null) options.getRequestTimeout = 15*1000;
        if(options.postRequestTimeout==null) options.postRequestTimeout = 30*1000;
        this.options = options;

    }

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(amount: BN, url: string): Promise<LnForGasSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const receiveAddress = this.contract.getAddress();

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/createInvoice?address="+encodeURIComponent(receiveAddress)+"&amount="+encodeURIComponent(amount.toString(10)), {
            method: "GET",
            timeout: this.options.getRequestTimeout
        }));

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json();

        const swap = new LnForGasSwap(this, jsonBody.data.pr, url, new BN(jsonBody.data.total), new BN(jsonBody.data.swapFee), receiveAddress);
        this.swaps[swap.getPaymentHash().toString("hex")] = swap;
        await swap.save();
        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        await this.storage.init();
        const swapData = await this.storage.loadData(LnForGasSwap);

        this.swaps = {};
        swapData.forEach(e => {
            e.wrapper = this;
            this.swaps[e.getPaymentHash().toString("hex")] = e;
        });

        console.log("Loaded LnForGas: ", swapData);

        const processSwap: (swap: LnForGasSwap<T>) => Promise<boolean> = async (swap: LnForGasSwap<T>) => {
            if(swap.state===LnForGasSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await swap.getInvoiceStatus();
                    if(res.is_paid) {
                        return false;
                    }
                    if(swap.getTimeoutTime()<Date.now()) {
                        swap.state = LnForGasSwapState.EXPIRED;
                        return true;
                    }
                } catch (e) {
                    console.error(e);
                    if(e instanceof PaymentAuthError) {
                        swap.state = LnForGasSwapState.FAILED;
                        return true;
                    }
                }
                return false;
            }
        };

        let promises = [];
        for(let paymentHash in this.swaps) {
            const swap: LnForGasSwap<T> = this.swaps[paymentHash];

            promises.push(processSwap(swap).then(changed => {
                if(swap.state===LnForGasSwapState.EXPIRED || swap.state===LnForGasSwapState.FAILED) {
                    delete this.swaps[swap.getPaymentHash().toString("hex")];
                    this.storage.removeData(swap.getPaymentHash().toString("hex"));
                } else {
                    if(changed) return this.storage.saveData(swap.getPaymentHash().toString("hex"), swap);
                }
            }));
            if(promises.length>=this.MAX_CONCURRENT_REQUESTS) {
                await Promise.all(promises);
                promises = [];
            }
        }
        if(promises.length>0) await Promise.all(promises);

        console.log("Swap data checked");

        this.isInitialized = true;
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<LnForGasSwap<T>[]> {
        return Promise.resolve(this.getAllSwapsSync());
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwapsSync(): LnForGasSwap<T>[] {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: LnForGasSwap<T>[] = [];

        for(let paymentHash in this.swaps) {
            const swap = this.swaps[paymentHash];

            console.log(swap);

            if(swap.recipient!==this.contract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

}
