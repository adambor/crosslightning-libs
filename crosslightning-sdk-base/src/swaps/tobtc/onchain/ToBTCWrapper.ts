import {ToBTCSwap} from "./ToBTCSwap";
import {IToBTCWrapper} from "../IToBTCWrapper";
import {
    ChainEvents,
    ChainSwapType,
    IntermediaryReputationType,
    IStorageManager,
    SwapContract,
    SwapData
} from "crosslightning-base";
import { Intermediary } from "../../../intermediaries/Intermediary";
import {ISwapPrice} from "../../../prices/abstract/ISwapPrice";
import {EventEmitter} from "events";
import {BitcoinRpc} from "crosslightning-base/dist";
import {AmountData, ISwapWrapperOptions} from "../../ISwapWrapper";
import {Network, networks, address} from "bitcoinjs-lib";
import * as BN from "bn.js";
import {Buffer} from "buffer";
import randomBytes from "randombytes";
import {UserError} from "../../../errors/UserError";
import {IntermediaryError} from "../../../errors/IntermediaryError";
import {SwapType} from "../../SwapType";
import {extendAbortController, tryWithRetries} from "../../../utils/Utils";
import {IntermediaryAPI, ToBTCResponseType} from "../../../intermediaries/IntermediaryAPI";
import {RequestError} from "../../../errors/RequestError";

export type ToBTCOptions = {
    confirmationTarget: number,
    confirmations: number
}

export type ToBTCWrapperOptions = ISwapWrapperOptions & {
    safetyFactor?: number,
    maxConfirmations?: number,
    bitcoinNetwork?: Network,

    bitcoinBlocktime?: number,

    maxExpectedOnchainSendSafetyFactor?: number,
    maxExpectedOnchainSendGracePeriodBlocks?: number,
};

export class ToBTCWrapper<T extends SwapData, TXType = any> extends IToBTCWrapper<T, ToBTCSwap<T, TXType>, ToBTCWrapperOptions, TXType> {
    protected readonly swapDeserializer = ToBTCSwap;

    readonly btcRpc: BitcoinRpc<any>;

    /**
     * @param storage Storage interface for the current environment
     * @param contract Chain specific swap contract
     * @param prices Swap pricing handler
     * @param chainEvents Smart chain on-chain event listener
     * @param swapDataDeserializer Deserializer for chain specific SwapData
     * @param btcRpc Bitcoin RPC api
     * @param options
     * @param events Instance to use for emitting events
     */
    constructor(
        storage: IStorageManager<ToBTCSwap<T, TXType>>,
        contract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        prices: ISwapPrice,
        swapDataDeserializer: new (data: any) => T,
        btcRpc: BitcoinRpc<any>,
        options?: ToBTCWrapperOptions,
        events?: EventEmitter<{swapState: [ToBTCSwap<T, TXType>]}>
    ) {
        if(options==null) options = {};
        options.bitcoinNetwork = options.bitcoinNetwork || networks.testnet;
        options.safetyFactor = options.safetyFactor || 2;
        options.maxConfirmations = options.maxConfirmations || 6;
        options.bitcoinBlocktime = options.bitcoinBlocktime|| (60*10);
        options.maxExpectedOnchainSendSafetyFactor = options.maxExpectedOnchainSendSafetyFactor || 4;
        options.maxExpectedOnchainSendGracePeriodBlocks = options.maxExpectedOnchainSendGracePeriodBlocks || 12;
        super(storage, contract, chainEvents, prices, swapDataDeserializer, options, events);
        this.btcRpc = btcRpc;
    }

    /**
     * Returns randomly generated random escrow nonce to be used for to BTC on-chain swaps
     * @private
     * @returns Escrow nonce
     */
    private getRandomNonce(): BN {
        const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);

        const nonceBuffer = Buffer.concat([
            Buffer.from(firstPart.toArray("be", 5)),
            randomBytes(3)
        ]);

        return new BN(nonceBuffer, "be");
    }

    /**
     * Converts bitcoin address to its corresponding output script
     *
     * @param addr Bitcoin address to get the output script for
     * @private
     * @returns Output script as Buffer
     * @throws {UserError} if invalid address is specified
     */
    private btcAddressToOutputScript(addr: string): Buffer {
        try {
            return address.toOutputScript(addr, this.options.bitcoinNetwork);
        } catch (e) {
            throw new UserError("Invalid address specified");
        }
    }

    /**
     * Verifies returned LP data
     *
     * @param resp LP's response
     * @param amountData
     * @param lp
     * @param options Options as passed to the swap create function
     * @param data LP's returned parsed swap data
     * @param hash Payment hash of the swap
     * @param nonce Escrow nonce that should be used for the swap
     * @private
     * @throws {IntermediaryError} if returned data are not correct
     */
    private verifyReturnedData(
        resp: ToBTCResponseType,
        amountData: AmountData,
        lp: Intermediary,
        options: ToBTCOptions,
        data: T,
        hash: string,
        nonce: BN
    ): void {
        if(!resp.totalFee.eq(resp.swapFee.add(resp.networkFee))) throw new IntermediaryError("Invalid totalFee returned");

        if(amountData.exactIn) {
            if(!resp.total.eq(amountData.amount)) throw new IntermediaryError("Invalid total returned");
        } else {
            if(!resp.amount.eq(amountData.amount)) throw new IntermediaryError("Invalid amount returned");
        }

        const maxAllowedBlockDelta: BN = new BN(
            options.confirmations+
            options.confirmationTarget+
            this.options.maxExpectedOnchainSendGracePeriodBlocks
        );
        const maxAllowedExpiryDelta: BN = maxAllowedBlockDelta
            .muln(this.options.maxExpectedOnchainSendSafetyFactor)
            .muln(this.options.bitcoinBlocktime);
        const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        const maxAllowedExpiryTimestamp: BN = currentTimestamp.add(maxAllowedExpiryDelta);

        if(data.getExpiry().gt(maxAllowedExpiryTimestamp)) {
            console.error("Expiry time returned: "+data.getExpiry()+" maxAllowed: "+maxAllowedExpiryTimestamp);
            throw new IntermediaryError("Expiry time returned too high!");
        }

        if(
            !data.getAmount().eq(resp.total) ||
            data.getHash()!==hash ||
            !data.getEscrowNonce().eq(nonce) ||
            data.getConfirmations()!==options.confirmations ||
            data.getType()!==ChainSwapType.CHAIN_NONCED ||
            !data.isPayIn() ||
            !data.isToken(amountData.token) ||
            data.getClaimer()!==lp.address
        ) {
            throw new IntermediaryError("Invalid data returned");
        }
    }

    /**
     * Returns quotes fetched from LPs, paying to an 'address' - a bitcoin address
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param amountData            Amount of token & amount to swap
     * @param lps                   LPs (liquidity providers) to get the quotes from
     * @param options               Quote options
     * @param additionalParams      Additional parameters sent to the LP when creating the swap
     * @param abortSignal           Abort signal for aborting the process
     */
    create(
        address: string,
        amountData: AmountData,
        lps: Intermediary[],
        options: ToBTCOptions,
        additionalParams?: Record<string, any>,
        abortSignal?: AbortSignal
    ): {
        quote: Promise<ToBTCSwap<T, TXType>>,
        intermediary: Intermediary
    }[] {
        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const nonce: BN = this.getRandomNonce();
        const outputScript: Buffer = this.btcAddressToOutputScript(address);
        const _hash: string = !amountData.exactIn ?
            this.contract.getHashForOnchain(outputScript, amountData.amount, nonce).toString("hex") :
            null;

        const _abortController = extendAbortController(abortSignal);
        const pricePreFetchPromise: Promise<BN | null> = this.preFetchPrice(amountData, _abortController.signal);
        const feeRatePromise: Promise<any> = this.preFetchFeeRate(amountData, _hash, _abortController);

        return lps.map(lp => {
            return {
                intermediary: lp,
                quote: (async () => {
                    const abortController = extendAbortController(_abortController.signal);
                    const reputationPromise: Promise<IntermediaryReputationType> = this.preFetchIntermediaryReputation(amountData, lp, abortController);

                    try {
                        const {signDataPromise, resp} = await tryWithRetries(async(retryCount) => {
                            const {signDataPrefetch, response} = IntermediaryAPI.initToBTC(lp.url, {
                                btcAddress: address,
                                amount: amountData.amount,
                                confirmationTarget: options.confirmationTarget,
                                confirmations: options.confirmations,
                                nonce: nonce,
                                token: amountData.token,
                                offerer: this.contract.getAddress(),
                                exactIn: amountData.exactIn,
                                feeRate: feeRatePromise,
                                additionalParams
                            }, this.options.postRequestTimeout, abortController.signal, retryCount>0 ? false : null);

                            return {
                                signDataPromise: this.preFetchSignData(signDataPrefetch),
                                resp: await response
                            };
                        }, null, RequestError, abortController.signal);

                        let hash: string = amountData.exactIn ?
                            this.contract.getHashForOnchain(outputScript, resp.amount, nonce).toString("hex") :
                            _hash;
                        const data: T = new this.swapDataDeserializer(resp.data);
                        this.contract.setUsAsOfferer(data);

                        this.verifyReturnedData(resp, amountData, lp, options, data, hash, nonce);
                        const [pricingInfo, signatureExpiry, reputation] = await Promise.all([
                            this.verifyReturnedPrice(
                                lp.services[SwapType.TO_BTC], true, resp.amount, data.getAmount(),
                                data.getToken(), resp, pricePreFetchPromise, abortController.signal
                            ),
                            this.verifyReturnedSignature(data, resp, feeRatePromise, signDataPromise, abortController.signal),
                            reputationPromise
                        ]);
                        abortController.signal.throwIfAborted();

                        lp.reputation[amountData.token.toString()] = reputation;

                        return new ToBTCSwap<T, TXType>(this, {
                            pricingInfo,
                            url: lp.url,
                            expiry: signatureExpiry,
                            swapFee: resp.swapFee,
                            feeRate: await feeRatePromise,
                            prefix: resp.prefix,
                            timeout: resp.timeout,
                            signature: resp.signature,
                            data,
                            networkFee: resp.networkFee,
                            address,
                            amount: resp.amount,
                            confirmationTarget: options.confirmationTarget,
                            satsPerVByte: resp.satsPervByte
                        });
                    } catch (e) {
                        abortController.abort(e);
                        throw e;
                    }
                })()
            }
        });
    }
}
