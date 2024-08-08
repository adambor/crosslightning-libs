import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {SwapData, TokenAddress} from "crosslightning-base";
import {SwapBaseConfig, SwapHandler} from "./SwapHandler";
import * as BN from "bn.js";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import {FieldTypeEnum} from "../utils/paramcoders/SchemaVerifier";

const secondsInYear = new BN(365*24*60*60);

export type FromBtcBaseConfig = SwapBaseConfig & {
    securityDepositAPY: number
};

export abstract class FromBtcBaseSwapHandler<V extends SwapHandlerSwap<T, S>, T extends SwapData, S> extends SwapHandler<V, T, S> {

    abstract config: FromBtcBaseConfig;

    /**
     * Starts a pre-fetch for swap price & security deposit price
     *
     * @param useToken
     * @param abortController
     */
    getFromBtcPricePrefetches(useToken: TokenAddress, abortController: AbortController): {
        pricePrefetchPromise: Promise<BN>,
        securityDepositPricePrefetchPromise: Promise<BN>
    } {
        const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken).catch(e => {
            this.logger.error("getFromBtcPricePrefetches(): pricePrefetch error: ", e);
            abortController.abort(e);
            return null;
        }) : null;
        const securityDepositPricePrefetchPromise: Promise<BN> = useToken.toString()===this.swapContract.getNativeCurrencyAddress().toString() ?
            pricePrefetchPromise :
            (this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(this.swapContract.getNativeCurrencyAddress()).catch(e => {
                this.logger.error("getFromBtcPricePrefetches(): securityDepositPricePrefetch error: ", e);
                abortController.abort(e);
                return null;
            }) : null);

        return {pricePrefetchPromise, securityDepositPricePrefetchPromise};
    }

    /**
     * Starts a pre-fetch for base security deposit (transaction fee for refunding transaction on our side)
     *
     * @param dummySwapData
     * @param abortController
     */
    getBaseSecurityDepositPrefetch(dummySwapData: T, abortController: AbortController): Promise<BN> {
        //Solana workaround
        if((this.swapContract as any).getRawRefundFee!=null) {
            return (this.swapContract as any).getRawRefundFee(dummySwapData).catch(e => {
                this.logger.error("getBaseSecurityDepositPrefetch(): pre-fetch error: ", e);
                abortController.abort(e);
                return null;
            });
        } else {
            return this.swapContract.getRefundFee(dummySwapData).then(result => result.mul(new BN(2))).catch(e => {
                this.logger.error("getBaseSecurityDepositPrefetch(): pre-fetch error: ", e);
                abortController.abort(e);
                return null;
            });
        }
    }

    /**
     * Starts a pre-fetch for vault balance
     *
     * @param useToken
     * @param abortController
     */
    getBalancePrefetch(useToken: TokenAddress, abortController: AbortController): Promise<BN> {
        return this.swapContract.getBalance(useToken, true).catch(e => {
            this.logger.error("getBalancePrefetch(): balancePrefetch error: ", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Checks if we have enough balance of the token in the swap vault
     *
     * @param totalInToken
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    async checkBalance(totalInToken: BN, balancePrefetch: Promise<BN>, signal: AbortSignal): Promise<void> {
        const balance = await balancePrefetch;
        signal.throwIfAborted();

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
     * @param exactOut
     * @param amount
     * @param useToken
     * @param fees
     * @param signal
     * @param pricePrefetchPromise
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    async checkFromBtcAmount(
        exactOut: boolean,
        amount: BN,
        useToken: TokenAddress,
        fees: {baseFee: BN, feePPM: BN},
        signal: AbortSignal,
        pricePrefetchPromise?: Promise<BN>
    ): Promise<{
        amountBD: BN,
        swapFee: BN,
        swapFeeInToken: BN,
        totalInToken: BN
    }> {
        let amountBD: BN;
        if(exactOut) {
            amountBD = await this.swapPricing.getToBtcSwapAmount(amount, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
            signal.throwIfAborted();

            // amt = (amt+base_fee)/(1-fee)
            amountBD = amountBD.add(fees.baseFee).mul(new BN(1000000)).div(new BN(1000000).sub(fees.feePPM));

            if(amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                let adjustedMin = this.config.min.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
                let adjustedMax = this.config.max.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
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
                let adjustedMin = this.config.min.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
                let adjustedMax = this.config.max.mul(new BN(1000000).sub(fees.feePPM)).div(new BN(1000000)).sub(fees.baseFee);
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
        } else {
            amountBD = amount;

            if(amountBD.lt(this.config.min)) {
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

        const swapFee = fees.baseFee.add(amountBD.mul(fees.feePPM).div(new BN(1000000)));
        const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
        signal.throwIfAborted();

        let totalInToken: BN;
        if(exactOut) {
            totalInToken = amount;
        } else {
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
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
     * @param amountBD
     * @param swapFee
     * @param expiryTimeout
     * @param baseSecurityDepositPromise
     * @param securityDepositPricePrefetchPromise
     * @param signal
     * @param metadata
     */
    async getSecurityDeposit(
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

        const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(
            amountBD.sub(swapFee),
            this.swapContract.getNativeCurrencyAddress(),
            true,
            securityDepositPricePrefetchPromise==null ? null : await securityDepositPricePrefetchPromise
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
     * @param swapObject
     * @param req
     * @param abortSignal
     * @param signDataPrefetchPromise
     */
    async getFromBtcSignatureData(swapObject: T, req: Request & {paramReader: IParamReader}, abortSignal: AbortSignal, signDataPrefetchPromise?: Promise<any>): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }> {
        const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;
        if(prefetchedSignData!=null) this.logger.debug("getFromBtcSignatureData(): pre-fetched signature data: ", prefetchedSignData);
        abortSignal.throwIfAborted();

        const feeRateObj = await req.paramReader.getParams({
            feeRate: FieldTypeEnum.String
        }).catch(e => null);
        abortSignal.throwIfAborted();

        const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;
        this.logger.debug("getFromBtcSignatureData(): using fee rate from client: ", feeRate);
        const sigData = await this.swapContract.getInitSignature(
            swapObject,
            this.config.authorizationTimeout,
            prefetchedSignData,
            feeRate
        );
        abortSignal.throwIfAborted();

        return sigData;
    }

}