
import {Express} from "express";
import {ISwapPrice} from "./ISwapPrice";
import {ChainEvents, StorageObject, SwapContract, SwapData, TokenAddress, IStorageManager} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {PluginManager} from "../plugins/PluginManager";
import {IIntermediaryStorage} from "../storage/IIntermediaryStorage";
import * as BN from "bn.js";
import {ServerParamEncoder} from "../utils/paramcoders/server/ServerParamEncoder";
import {FieldTypeEnum} from "../utils/paramcoders/SchemaVerifier";
import {IParamReader} from "../utils/paramcoders/IParamReader";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    tokens: string[],
    data?: any,
};

export type FromBtcBaseConfig = SwapBaseConfig & {
    refundInterval: number,
    securityDepositAPY: number
};

export type ToBtcBaseConfig = SwapBaseConfig & {
    swapCheckInterval: number
};

export type SwapBaseConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    gracePeriod: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
};

/**
 * An abstract class defining a singular swap service
 */
export abstract class SwapHandler<V extends SwapHandlerSwap<T>, T extends SwapData> {

    abstract readonly type: SwapHandlerType;

    readonly pdaExistsForToken: {
        [token: string]: boolean
    } = {};

    readonly storageManager: IIntermediaryStorage<V>;
    readonly path: string;

    readonly swapContract: SwapContract<T, any, any, any>;
    readonly chainEvents: ChainEvents<T>;
    readonly allowedTokens: Set<string>;
    readonly swapPricing: ISwapPrice;
    readonly LND: AuthenticatedLnd;

    abstract config: SwapBaseConfig;

    protected constructor(storageDirectory: IIntermediaryStorage<V>, path: string, swapContract: SwapContract<T, any, any, any>, chainEvents: ChainEvents<T>, allowedTokens: TokenAddress[], lnd: AuthenticatedLnd, swapPricing: ISwapPrice) {
        this.storageManager = storageDirectory;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.path = path;
        this.allowedTokens = new Set<string>(allowedTokens.map(e => e.toString()));
        this.LND = lnd;
        this.swapPricing = swapPricing;
    }

    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    abstract init(): Promise<void>;

    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    abstract startWatchdog(): Promise<void>;

    /**
     * Sets up required listeners for the REST server
     *
     * @param restServer
     */
    abstract startRestServer(restServer: Express): void;

    /**
     * Returns swap handler info
     */
    abstract getInfo(): SwapHandlerInfoType;

    async removeSwapData(hash: string, sequence: BN) {
        const swap = await this.storageManager.getData(hash, sequence);
        if(swap!=null) await PluginManager.swapRemove<T>(swap);
        await this.storageManager.removeData(hash, sequence);
    }

    async checkVaultInitialized(token: string): Promise<void> {
        if(!this.pdaExistsForToken[token]) {
            const reputation = await this.swapContract.getIntermediaryReputation(this.swapContract.getAddress(), this.swapContract.toTokenAddress(token));
            if(reputation!=null) {
                this.pdaExistsForToken[token] = true;
            } else {
                throw {
                    code: 20201,
                    msg: "Token not supported!"
                };
            }
        }
    }

    getAbortController(responseStream: ServerParamEncoder): AbortController {
        const abortController = new AbortController();
        const responseStreamAbortController = responseStream.getAbortSignal();
        responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));
        return abortController;
    }

    async checkToBtcAmount<T extends {networkFee: BN}>(
        exactIn: boolean,
        amount: BN,
        useToken: TokenAddress,
        fees: {baseFee: BN, feePPM: BN},
        getNetworkFee: (amount: BN) => Promise<T>,
        signal: AbortSignal,
        pricePrefetchPromise?: Promise<BN>
    ): Promise<{
        amountBD: BN,
        networkFeeData: T,
        swapFee: BN,
        swapFeeInToken: BN,
        networkFee: BN,
        networkFeeInToken: BN,
        totalInToken: BN
    }> {
        let amountBD: BN;
        let tooLow = false;
        if(exactIn) {
            amountBD = await this.swapPricing.getToBtcSwapAmount(amount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
            signal.throwIfAborted();

            //Decrease by base fee
            amountBD = amountBD.sub(fees.baseFee);

            //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
            if(amountBD.lt(this.config.min)) {
                amountBD = this.config.min;
                tooLow = true;
            }
        } else {
            amountBD = amount;

            if (amountBD.lt(this.config.min)) {
                throw {
                    code: 20003,
                    msg: "Amount too low!",
                    data: {
                        min: this.config.min.toString(10),
                        max: this.config.max.toString(10)
                    }
                };
            }

            if(amountBD.gt(this.config.max)) {
                throw {
                    code: 20004,
                    msg: "Amount too high!",
                    data: {
                        min: this.config.min.toString(10),
                        max: this.config.max.toString(10)
                    }
                };
            }
        }

        const resp = await getNetworkFee(amountBD);
        signal.throwIfAborted();

        if(exactIn) {
            //Decrease by network fee
            amountBD = amountBD.sub(resp.networkFee);

            //Decrease by percentage fee
            amountBD = amountBD.mul(new BN(1000000)).div(fees.feePPM.add(new BN(1000000)));

            if(tooLow || amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                //Compute min/max
                let adjustedMin = this.config.min.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                let adjustedMax = this.config.max.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                adjustedMin = adjustedMin.add(fees.baseFee).add(resp.networkFee);
                adjustedMax = adjustedMax.add(fees.baseFee).add(resp.networkFee);
                const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                throw {
                    code: 20003,
                    msg: "Amount too low!",
                    data: {
                        min: minIn.toString(10),
                        max: maxIn.toString(10)
                    }
                };
            }
            if(amountBD.gt(this.config.max.mul(new BN(105)).div(new BN(100)))) {
                let adjustedMin = this.config.min.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                let adjustedMax = this.config.max.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                adjustedMin = adjustedMin.add(fees.baseFee).add(resp.networkFee);
                adjustedMax = adjustedMax.add(fees.baseFee).add(resp.networkFee);
                const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                throw {
                    code: 20004,
                    msg: "Amount too high!",
                    data: {
                        min: minIn.toString(10),
                        max: maxIn.toString(10)
                    }
                };
            }
        }

        const swapFee = fees.baseFee.add(amountBD.mul(fees.feePPM).div(new BN(1000000)));

        const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(resp.networkFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
        const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

        signal.throwIfAborted();

        let total: BN;
        if(exactIn) {
            total = amount;
        } else {
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amount, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
            signal.throwIfAborted();
            total = amountInToken.add(swapFeeInToken).add(networkFeeInToken);
        }

        return {amountBD, networkFeeData: resp, swapFee, swapFeeInToken, networkFee: resp.networkFee, networkFeeInToken, totalInToken: total};
    }

    getToBtcPrefetches(token: TokenAddress, responseStream: ServerParamEncoder, abortController: AbortController): {
        pricePrefetchPromise?: Promise<BN>,
        signDataPrefetchPromise?: Promise<any>
    } {
        //Fetch pricing & signature data in parallel
        const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(token).catch(e => {
            console.error("To BTC/BTC-LN: REST.pricePrefetch", e);
            abortController.abort(e);
            return null;
        }) : null;
        let signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
            console.error("To BTC/BTC-LN: REST.signDataPrefetch", e);
            abortController.abort(e);
            return null;
        }) : null;

        if(pricePrefetchPromise!=null) console.log("[To BTC/BTC-LN: REST.payInvoice] Pre-fetching swap price!");
        if(signDataPrefetchPromise!=null) {
            signDataPrefetchPromise = signDataPrefetchPromise.then(val => val==null || abortController.signal.aborted ? null : responseStream.writeParams({
                signDataPrefetch: val
            }).then(() => val).catch(e => {
                console.error("[To BTC/BTC-LN: REST.payInvoice] Send signDataPreFetch error: ", e);
                abortController.abort(e);
                return null;
            }));
            if(signDataPrefetchPromise!=null) console.log("[To BTC/BTC-LN: REST.payInvoice] Pre-fetching signature data!");
        }

        return {
            pricePrefetchPromise,
            signDataPrefetchPromise
        }
    }

    async getToBtcSignatureData(swapObject: T, req: Request & {paramReader: IParamReader}, abortSignal: AbortSignal, signDataPrefetchPromise?: Promise<any>): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }> {
        const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;
        if(prefetchedSignData!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched signature data: ", prefetchedSignData);

        abortSignal.throwIfAborted();

        const feeRateObj = await req.paramReader.getParams({
            feeRate: FieldTypeEnum.String
        }).catch(e => null);

        abortSignal.throwIfAborted();

        const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;
        const sigData = await this.swapContract.getClaimInitSignature(
            swapObject,
            this.config.authorizationTimeout,
            prefetchedSignData,
            feeRate
        );

        abortSignal.throwIfAborted();

        return sigData;
    }

}
