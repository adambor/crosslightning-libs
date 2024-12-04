import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData} from "crosslightning-base";
import {RequestData, SwapBaseConfig, SwapHandler} from "./SwapHandler";
import * as BN from "bn.js";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import {FieldTypeEnum} from "../utils/paramcoders/SchemaVerifier";
import {FromBtcLnRequestType} from "./frombtcln_abstract/FromBtcLnAbs";
import {FromBtcRequestType} from "./frombtc_abstract/FromBtcAbs";
import {PluginManager} from "../plugins/PluginManager";
import {
    isPluginQuote,
    isQuoteSetFees
} from "../plugins/IPlugin";
import {Request} from "express";

const secondsInYear = new BN(365*24*60*60);

export type FromBtcBaseConfig = SwapBaseConfig & {
    securityDepositAPY: number
};

export abstract class FromBtcBaseSwapHandler<V extends SwapHandlerSwap<SwapData, S>, S> extends SwapHandler<V, S> {

    abstract config: FromBtcBaseConfig;

    /**
     * Starts a pre-fetch for swap price & security deposit price
     *
     * @param chainIdentifier
     * @param useToken
     * @param abortController
     */
    protected getFromBtcPricePrefetches(chainIdentifier: string, useToken: string, abortController: AbortController): {
        pricePrefetchPromise: Promise<BN>,
        securityDepositPricePrefetchPromise: Promise<BN>
    } {
        const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice(useToken, chainIdentifier).catch(e => {
            this.logger.error("getFromBtcPricePrefetches(): pricePrefetch error: ", e);
            abortController.abort(e);
            return null;
        });
        const {swapContract} = this.getChain(chainIdentifier);
        const securityDepositPricePrefetchPromise: Promise<BN> = useToken.toString()===swapContract.getNativeCurrencyAddress().toString() ?
            pricePrefetchPromise :
            this.swapPricing.preFetchPrice(swapContract.getNativeCurrencyAddress(), chainIdentifier).catch(e => {
                this.logger.error("getFromBtcPricePrefetches(): securityDepositPricePrefetch error: ", e);
                abortController.abort(e);
                return null;
            });

        return {pricePrefetchPromise, securityDepositPricePrefetchPromise};
    }

    /**
     * Starts a pre-fetch for base security deposit (transaction fee for refunding transaction on our side)
     *
     * @param chainIdentifier
     * @param dummySwapData
     * @param abortController
     */
    protected async getBaseSecurityDepositPrefetch(chainIdentifier: string, dummySwapData: SwapData, abortController: AbortController): Promise<BN> {
        //Solana workaround
        const {swapContract} = this.getChain(chainIdentifier);
        if (swapContract.getRawRefundFee != null) {
            try {
                return await swapContract.getRawRefundFee(dummySwapData);
            } catch (e) {
                this.logger.error("getBaseSecurityDepositPrefetch(): pre-fetch error: ", e);
                abortController.abort(e);
                return null;
            }
        } else {
            try {
                const result = await swapContract.getRefundFee(dummySwapData);
                return result.mul(new BN(2));
            } catch (e1) {
                this.logger.error("getBaseSecurityDepositPrefetch(): pre-fetch error: ", e1);
                abortController.abort(e1);
                return null;
            }
        }
    }

    /**
     * Starts a pre-fetch for vault balance
     *
     * @param chainIdentifier
     * @param useToken
     * @param abortController
     */
    protected async getBalancePrefetch(chainIdentifier: string, useToken: string, abortController: AbortController): Promise<BN> {
        const {swapContract, signer} = this.getChain(chainIdentifier);
        try {
            return await swapContract.getBalance(signer.getAddress(), useToken, true);
        } catch (e) {
            this.logger.error("getBalancePrefetch(): balancePrefetch error: ", e);
            abortController.abort(e);
            return null;
        }
    }

    /**
     * Checks if we have enough balance of the token in the swap vault
     *
     * @param totalInToken
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    protected async checkBalance(totalInToken: BN, balancePrefetch: Promise<BN>, signal: AbortSignal | null): Promise<void> {
        const balance = await balancePrefetch;
        if(signal!=null) signal.throwIfAborted();

        if(balance==null || balance.lt(totalInToken)) {
            throw {
                code: 20002,
                msg: "Not enough liquidity"
            };
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
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        useToken: string
    ): Promise<{baseFee: BN, feePPM: BN}> {
        const res = await PluginManager.onHandlePreFromBtcQuote(
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
        if(requestedAmount.input) this.checkBtcAmountInBounds(requestedAmount.amount);
        return {
            baseFee: this.config.baseFee,
            feePPM: this.config.feePPM
        };
    }

    /**
     * Checks minimums/maximums, calculates the fee & total amount
     *
     * @param request
     * @param requestedAmount
     * @param fees
     * @param useToken
     * @param signal
     * @param pricePrefetchPromise
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    protected async checkFromBtcAmount(
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType>,
        requestedAmount: {input: boolean, amount: BN},
        fees: {baseFee: BN, feePPM: BN},
        useToken: string,
        signal: AbortSignal,
        pricePrefetchPromise: Promise<BN> = Promise.resolve(null)
    ): Promise<{
        amountBD: BN,
        swapFee: BN, //Swap fee in BTC
        swapFeeInToken: BN, //Swap fee in token on top of what should be paid out to the user
        totalInToken: BN //Total to be paid out to the user
    }> {
        const chainIdentifier = request.chainIdentifier;

        const res = await PluginManager.onHandlePostFromBtcQuote(
            request,
            requestedAmount,
            chainIdentifier,
            useToken,
            {minInBtc: this.config.min, maxInBtc: this.config.max},
            {baseFeeInBtc: fees.baseFee, feePPM: fees.feePPM},
            pricePrefetchPromise
        );
        signal.throwIfAborted();
        if(res!=null) {
            this.handlePluginErrorResponses(res);
            if(isQuoteSetFees(res)) {
                if(res.baseFee!=null) fees.baseFee = res.baseFee;
                if(res.feePPM!=null) fees.feePPM = res.feePPM;
            }
            if(isPluginQuote(res)) {
                if(!requestedAmount.input) {
                    return {
                        amountBD: res.amount.amount.add(res.swapFee.inInputTokens),
                        swapFee: res.swapFee.inInputTokens,
                        swapFeeInToken: res.swapFee.inOutputTokens,
                        totalInToken: requestedAmount.amount
                    }
                } else {
                    return {
                        amountBD: requestedAmount.amount,
                        swapFee: res.swapFee.inInputTokens,
                        swapFeeInToken: res.swapFee.inOutputTokens,
                        totalInToken: res.amount.amount
                    }
                }
            }
        }

        let amountBD: BN;
        if(!requestedAmount.input) {
            amountBD = await this.swapPricing.getToBtcSwapAmount(requestedAmount.amount, useToken, chainIdentifier, true, pricePrefetchPromise);
            signal.throwIfAborted();

            // amt = (amt+base_fee)/(1-fee)
            amountBD = amountBD.add(fees.baseFee).mul(new BN(1000000)).div(new BN(1000000).sub(fees.feePPM));

            const tooLow = amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)));
            const tooHigh = amountBD.gt(this.config.max.mul(new BN(105)).div(new BN(100)));
            if(tooLow || tooHigh) {
                const adjustedMin = this.config.min.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
                const adjustedMax = this.config.max.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
                const minIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMin, useToken, chainIdentifier, null, pricePrefetchPromise
                );
                const maxIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMax, useToken, chainIdentifier, null, pricePrefetchPromise
                );
                throw {
                    code: tooLow ? 20003 : 20004,
                    msg: tooLow ? "Amount too low!" : "Amount too high!",
                    data: {
                        min: minIn.toString(10),
                        max: maxIn.toString(10)
                    }
                };
            }
        } else {
            amountBD = requestedAmount.amount;
            this.checkBtcAmountInBounds(amountBD);
        }

        const swapFee = fees.baseFee.add(amountBD.mul(fees.feePPM).div(new BN(1000000)));
        const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, chainIdentifier, true, pricePrefetchPromise);
        signal.throwIfAborted();

        let totalInToken: BN;
        if(!requestedAmount.input) {
            totalInToken = requestedAmount.amount;
        } else {
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(requestedAmount.amount, useToken, chainIdentifier, null, pricePrefetchPromise);
            totalInToken = amountInToken.sub(swapFeeInToken);
            signal.throwIfAborted();
        }

        return {
            amountBD,
            swapFee,
            swapFeeInToken,
            totalInToken
        }
    }

    /**
     * Calculates the required security deposit
     *
     * @param chainIdentifier
     * @param amountBD
     * @param swapFee
     * @param expiryTimeout
     * @param baseSecurityDepositPromise
     * @param securityDepositPricePrefetchPromise
     * @param signal
     * @param metadata
     */
    protected async getSecurityDeposit(
        chainIdentifier: string,
        amountBD: BN,
        swapFee: BN,
        expiryTimeout: BN,
        baseSecurityDepositPromise: Promise<BN>,
        securityDepositPricePrefetchPromise: Promise<BN>,
        signal: AbortSignal,
        metadata: any
    ): Promise<BN> {
        let baseSD: BN = await baseSecurityDepositPromise;

        signal.throwIfAborted();

        metadata.times.refundFeeFetched = Date.now();

        const {swapContract} = this.getChain(chainIdentifier);

        const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(
            amountBD.sub(swapFee),
            swapContract.getNativeCurrencyAddress(),
            chainIdentifier,
            true,
            securityDepositPricePrefetchPromise
        );

        signal.throwIfAborted();

        const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));
        const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);

        this.logger.debug(
            "getSecurityDeposit(): base security deposit: "+baseSD.toString(10)+
            " swap output in native: "+swapValueInNativeCurrency.toString(10)+
            " apy ppm: "+apyPPM.toString(10)+
            " expiry timeout: "+expiryTimeout.toString(10)+
            " variable security deposit: "+variableSD.toString(10)
        );

        return baseSD.add(variableSD);
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
    protected async getFromBtcSignatureData(
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
        const {swapContract, signer} = this.getChain(chainIdentifier);

        const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;
        if(prefetchedSignData!=null) this.logger.debug("getFromBtcSignatureData(): pre-fetched signature data: ", prefetchedSignData);
        abortSignal.throwIfAborted();

        const feeRateObj = await req.paramReader.getParams({
            feeRate: FieldTypeEnum.String
        }).catch(() => null);
        abortSignal.throwIfAborted();

        const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;
        this.logger.debug("getFromBtcSignatureData(): using fee rate from client: ", feeRate);
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