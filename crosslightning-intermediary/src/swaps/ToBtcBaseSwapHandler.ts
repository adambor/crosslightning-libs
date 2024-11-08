import {RequestData, SwapBaseConfig, SwapHandler} from "./SwapHandler";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData} from "crosslightning-base";
import * as BN from "bn.js";
import {ServerParamEncoder} from "../utils/paramcoders/server/ServerParamEncoder";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import {FieldTypeEnum} from "../utils/paramcoders/SchemaVerifier";
import {PluginManager} from "../plugins/PluginManager";
import {
    isQuoteSetFees,
    isToBtcPluginQuote
} from "../plugins/IPlugin";
import {ToBtcLnRequestType} from "./tobtcln_abstract/ToBtcLnAbs";
import {ToBtcRequestType} from "./tobtc_abstract/ToBtcAbs";
import {Request} from "express";

export type ToBtcBaseConfig = SwapBaseConfig & {
    gracePeriod: BN
};

export abstract class ToBtcBaseSwapHandler<V extends SwapHandlerSwap<SwapData, S>, S> extends SwapHandler<V, S> {

    readonly pdaExistsForToken: {
        [chainIdentifier: string]: {
            [token: string]: boolean
        }
    } = {};

    abstract config: ToBtcBaseConfig;

    protected async checkVaultInitialized(chainIdentifier: string, token: string): Promise<void> {
        if(!this.pdaExistsForToken[chainIdentifier] || !this.pdaExistsForToken[chainIdentifier][token]) {
            this.logger.debug("checkVaultInitialized(): checking vault exists for chain: "+chainIdentifier+" token: "+token);
            const {swapContract, signer} = this.getChain(chainIdentifier);
            const reputation = await swapContract.getIntermediaryReputation(signer.getAddress(), token);
            this.logger.debug("checkVaultInitialized(): vault state, chain: "+chainIdentifier+" token: "+token+" exists: "+(reputation!=null));
            if(reputation!=null) {
                if(this.pdaExistsForToken[chainIdentifier]==null) this.pdaExistsForToken[chainIdentifier] = {};
                this.pdaExistsForToken[chainIdentifier][token] = true;
            } else {
                throw {
                    code: 20201,
                    msg: "Token not supported!"
                };
            }
        }
    }

    /**
     * Checks minimums/maximums, calculates the fee & total amount
     *
     * @param request
     * @param requestedAmount
     * @param useToken
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    protected async preCheckAmounts(
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        useToken: string
    ): Promise<{baseFee: BN, feePPM: BN}> {
        const res = await PluginManager.onHandlePreToBtcQuote(
            request,
            requestedAmount,
            request.chainIdentifier,
            useToken,
            {minInBtc: this.config.min, maxInBtc: this.config.max},
            {baseFeeInBtc: this.config.baseFee, feePPM: this.config.feePPM},
        );
        if(res!=null) {
            this.handlePluginErrorResponses(res);
            if(isQuoteSetFees(res)) {
                return {
                    baseFee: res.baseFee || this.config.baseFee,
                    feePPM: res.feePPM || this.config.feePPM
                }
            }
        }
        if(!requestedAmount.input) {
            this.checkBtcAmountInBounds(requestedAmount.amount);
        }
        return {
            baseFee: this.config.baseFee,
            feePPM: this.config.feePPM
        };
    }

    /**
     * Checks minimums/maximums, calculates network fee (based on the callback passed), swap fee & total amount
     *
     * @param request
     * @param requestedAmount
     * @param fees
     * @param useToken
     * @param getNetworkFee
     * @param signal
     * @param pricePrefetchPromise
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds,
     *  or if we don't have enough funds (getNetworkFee callback throws)
     */
    protected async checkToBtcAmount<T extends {networkFee: BN}>(
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        fees: {baseFee: BN, feePPM: BN},
        useToken: string,
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
        const chainIdentifier = request.chainIdentifier;

        const res = await PluginManager.onHandlePostToBtcQuote<T>(
            request,
            requestedAmount,
            request.chainIdentifier,
            useToken,
            {minInBtc: this.config.min, maxInBtc: this.config.max},
            {baseFeeInBtc: fees.baseFee, feePPM: fees.feePPM, networkFeeGetter: getNetworkFee},
            pricePrefetchPromise
        );
        signal.throwIfAborted();
        if(res!=null) {
            this.handlePluginErrorResponses(res);
            if(isQuoteSetFees(res)) {
                if(res.baseFee!=null) fees.baseFee = res.baseFee;
                if(res.feePPM!=null) fees.feePPM = res.feePPM;
            }
            if(isToBtcPluginQuote(res)) {
                if(requestedAmount.input) {
                    return {
                        amountBD: res.amount.amount,
                        swapFee: res.swapFee.inOutputTokens,
                        swapFeeInToken: res.swapFee.inInputTokens,
                        networkFee: res.networkFee.inOutputTokens,
                        networkFeeInToken: res.networkFee.inInputTokens,
                        networkFeeData: res.networkFeeData,
                        totalInToken: requestedAmount.amount
                    }
                } else {
                    return {
                        amountBD: requestedAmount.amount,
                        swapFee: res.swapFee.inOutputTokens,
                        swapFeeInToken: res.swapFee.inInputTokens,
                        networkFee: res.networkFee.inOutputTokens,
                        networkFeeInToken: res.networkFee.inInputTokens,
                        networkFeeData: res.networkFeeData,
                        totalInToken: res.amount.amount.add(res.swapFee.inInputTokens).add(res.networkFee.inInputTokens)
                    }
                }
            }
        }

        let amountBD: BN;
        let tooLow = false;
        if(requestedAmount.input) {
            amountBD = await this.swapPricing.getToBtcSwapAmount(requestedAmount.amount, useToken, chainIdentifier, null, pricePrefetchPromise);
            signal.throwIfAborted();

            //Decrease by base fee
            amountBD = amountBD.sub(fees.baseFee);

            //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
            if(amountBD.lt(this.config.min)) {
                amountBD = this.config.min;
                tooLow = true;
            }
        } else {
            amountBD = requestedAmount.amount;
            this.checkBtcAmountInBounds(amountBD);
        }

        const resp = await getNetworkFee(amountBD);
        this.logger.debug("checkToBtcAmount(): network fee calculated, amount: "+amountBD.toString(10)+" fee: "+resp.networkFee.toString(10));
        signal.throwIfAborted();

        if(requestedAmount.input) {
            //Decrease by network fee
            amountBD = amountBD.sub(resp.networkFee);

            //Decrease by percentage fee
            amountBD = amountBD.mul(new BN(1000000)).div(fees.feePPM.add(new BN(1000000)));

            const tooHigh = amountBD.gt(this.config.max.mul(new BN(105)).div(new BN(100)));
            tooLow ||= amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)));
            if(tooLow || tooHigh) {
                //Compute min/max
                let adjustedMin = this.config.min.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                let adjustedMax = this.config.max.mul(fees.feePPM.add(new BN(1000000))).div(new BN(1000000));
                adjustedMin = adjustedMin.add(fees.baseFee).add(resp.networkFee);
                adjustedMax = adjustedMax.add(fees.baseFee).add(resp.networkFee);
                const minIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMin, useToken, chainIdentifier, null, pricePrefetchPromise
                );
                const maxIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMax, useToken, chainIdentifier, null, pricePrefetchPromise
                );
                throw {
                    code: tooLow ? 20003 : 2004,
                    msg: tooLow ? "Amount too low!" : "Amount too high!",
                    data: {
                        min: minIn.toString(10),
                        max: maxIn.toString(10)
                    }
                };
            }
        }

        const swapFee = fees.baseFee.add(amountBD.mul(fees.feePPM).div(new BN(1000000)));

        const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(
            resp.networkFee, useToken, chainIdentifier, true, pricePrefetchPromise
        );
        const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(
            swapFee, useToken, chainIdentifier, true, pricePrefetchPromise
        );
        signal.throwIfAborted();

        let total: BN;
        if(requestedAmount.input) {
            total = requestedAmount.amount;
        } else {
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(
                requestedAmount.amount, useToken, chainIdentifier, true, pricePrefetchPromise
            );
            signal.throwIfAborted();
            total = amountInToken.add(swapFeeInToken).add(networkFeeInToken);
        }

        return {amountBD, networkFeeData: resp, swapFee, swapFeeInToken, networkFee: resp.networkFee, networkFeeInToken, totalInToken: total};
    }

    /**
     * Starts pre-fetches for swap pricing & signature data
     *
     * @param chainIdentifier
     * @param token
     * @param responseStream
     * @param abortController
     */
    protected getToBtcPrefetches(chainIdentifier: string, token: string, responseStream: ServerParamEncoder, abortController: AbortController): {
        pricePrefetchPromise?: Promise<BN>,
        signDataPrefetchPromise?: Promise<any>
    } {
        //Fetch pricing & signature data in parallel
        const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice(token, chainIdentifier).catch(e => {
            this.logger.error("getToBtcPrefetches(): pricePrefetch error", e);
            abortController.abort(e);
            return null;
        });

        return {
            pricePrefetchPromise,
            signDataPrefetchPromise: this.getSignDataPrefetch(chainIdentifier, abortController, responseStream)
        }
    }

    /**
     * Signs the created swap
     *
     * @param chainIdentifier
     * @param swapObject
     * @param req
     * @param abortSignal
     * @param signDataPrefetchPromise
     */
    protected async getToBtcSignatureData(
        chainIdentifier: string,
        swapObject: SwapData,
        req: Request & {paramReader: IParamReader},
        abortSignal: AbortSignal,
        signDataPrefetchPromise?: Promise<any>
    ): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }> {
        const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;
        if(prefetchedSignData!=null) this.logger.debug("getToBtcSignatureData(): pre-fetched signature data: ", prefetchedSignData);
        abortSignal.throwIfAborted();

        const feeRateObj = await req.paramReader.getParams({
            feeRate: FieldTypeEnum.String
        }).catch(() => null);
        abortSignal.throwIfAborted();

        const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;
        this.logger.debug("getToBtcSignatureData(): using fee rate from client: ", feeRate);
        const {swapContract, signer} = this.getChain(chainIdentifier);
        const sigData = await swapContract.getInitSignature(
            signer,
            swapObject,
            this.config.authorizationTimeout,
            prefetchedSignData,
            feeRate
        );
        abortSignal.throwIfAborted();

        return sigData;
    }

}