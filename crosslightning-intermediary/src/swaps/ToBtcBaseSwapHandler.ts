import {SwapBaseConfig, SwapHandler} from "./SwapHandler";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData, TokenAddress} from "crosslightning-base";
import * as BN from "bn.js";
import {ServerParamEncoder} from "../utils/paramcoders/server/ServerParamEncoder";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import {FieldTypeEnum} from "../utils/paramcoders/SchemaVerifier";

export type ToBtcBaseConfig = SwapBaseConfig;

export abstract class ToBtcBaseSwapHandler<V extends SwapHandlerSwap<T>, T extends SwapData> extends SwapHandler<V, T> {

    readonly pdaExistsForToken: {
        [token: string]: boolean
    } = {};

    abstract config: ToBtcBaseConfig;

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

    /**
     * Checks minimums/maximums, calculates network fee (based on the callback passed), swap fee & total amount
     *
     * @param exactIn
     * @param amount
     * @param useToken
     * @param fees
     * @param getNetworkFee
     * @param signal
     * @param pricePrefetchPromise
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds,
     *  or if we don't have enough funds (getNetworkFee callback throws)
     */
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

    /**
     * Starts pre-fetches for swap pricing & signature data
     *
     * @param token
     * @param responseStream
     * @param abortController
     */
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

        if(pricePrefetchPromise!=null) console.log("[To BTC/BTC-LN: REST.payInvoice] Pre-fetching swap price!");

        return {
            pricePrefetchPromise,
            signDataPrefetchPromise: this.getSignDataPrefetch(abortController, responseStream)
        }
    }

    /**
     * Signs the created swap
     *
     * @param swapObject
     * @param req
     * @param abortSignal
     * @param signDataPrefetchPromise
     */
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