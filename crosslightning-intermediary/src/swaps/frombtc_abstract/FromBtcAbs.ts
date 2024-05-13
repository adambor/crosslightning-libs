import * as BN from "bn.js";
import * as lncli from "ln-service";
import {Express} from "express";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
import {SwapHandler, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    IStorageManager,
    RefundEvent,
    SwapContract,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto";
import {expressHandlerWrapper} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import * as express from "express";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";

export type FromBtcConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    bitcoinNetwork: bitcoin.networks.Network

    confirmations: number,
    swapCsvDelta: number,

    refundInterval: number,

    securityDepositAPY: number
};

const secondsInYear = new BN(365*24*60*60);

export type FromBtcRequestType = {
    address: string,
    amount: BN,
    token: string,
    sequence: BN,
    exactOut?: boolean
};

/**
 * Swap handler handling from BTC swaps using PTLCs (proof-time locked contracts) and btc relay (on-chain bitcoin SPV)
 */
export class FromBtcAbs<T extends SwapData> extends SwapHandler<FromBtcSwapAbs<T>, T> {

    readonly type = SwapHandlerType.FROM_BTC;

    readonly config: FromBtcConfig & {swapTsCsvDelta: BN};

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, allowedTokens, lnd, swapPricing);
        const anyConfig = config as any;
        anyConfig.swapTsCsvDelta = new BN(config.swapCsvDelta).mul(config.bitcoinBlocktime.div(config.safetyFactor));
        this.config = anyConfig;
    }

    /**
     * Returns the TXO hash of the specific address and amount - sha256(u64le(amount) + outputScript(address))
     *
     * @param address
     * @param amount
     * @param bitcoinNetwork
     */
    private getTxoHash(address: string, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    /**
     * Returns the payment hash of the swap, takes swap nonce into account. Payment hash is chain-specific.
     *
     * @param address
     * @param nonce
     * @param amount
     * @param bitcoinNetwork
     */
    private getHash(address: string, nonce: BN, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);
        return this.swapContract.getHashForOnchain(parsedOutputScript, amount, nonce);
    }

    /**
     * Returns payment hash of the swap (hash WITH using payment nonce)
     *
     * @param swap
     */
    private getChainHash(swap: FromBtcSwapAbs<T>): Buffer {
        return this.getHash(swap.address, new BN(0), swap.amount, this.config.bitcoinNetwork);
    }

    /**
     * Returns TXO hash of the swap (hash without using payment nonce)
     *
     * @param swap
     */
    private getChainTxoHash(swap: FromBtcSwapAbs<T>): Buffer {
        return this.getTxoHash(swap.address, swap.amount, this.config.bitcoinNetwork);
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    private async checkPastSwaps() {

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    FromBtcSwapState.CREATED,
                    FromBtcSwapState.COMMITED
                ]
            }
        ]);

        const refundSwaps: FromBtcSwapAbs<T>[] = [];

        for(let swap of queriedData) {
            //Current time, minus maximum chain time skew
            const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

            //Once authorization expires in CREATED state, the user can no more commit it on-chain
            if(swap.state===FromBtcSwapState.CREATED) {
                const isExpired = swap.authorizationExpiry.lt(currentTime);
                if(isExpired) {
                    const isCommited = await this.swapContract.isCommited(swap.data);
                    if(isCommited) {
                        await swap.setState(FromBtcSwapState.COMMITED);
                        await this.storageManager.saveData(this.getChainHash(swap).toString("hex"), swap.data.getSequence(), swap);
                        continue;
                    }
                    await swap.setState(FromBtcSwapState.CANCELED);
                    await this.removeSwapData(this.getChainHash(swap).toString("hex"), swap.data.getSequence());
                }
                continue;
            }

            const expiryTime = swap.data.getExpiry();
            //Check if commited swap expired by now
            if(swap.state===FromBtcSwapState.COMMITED) {
                const isExpired = expiryTime.lt(currentTime);
                if(isExpired) {
                    const isCommited = await this.swapContract.isCommited(swap.data);

                    if(isCommited) {
                        refundSwaps.push(swap);
                        continue;
                    }

                    await swap.setState(FromBtcSwapState.CANCELED);
                    await this.removeSwapData(this.getChainHash(swap).toString("hex"), swap.data.getSequence());
                }
            }
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;
            await this.swapContract.refund(refundSwap.data, true, false, true);
            await refundSwap.setState(FromBtcSwapState.REFUNDED);
            //await PluginManager.swapStateChange(refundSwap);
            unlock();
        }
    }

    /**
     * Chain event processor
     *
     * @param eventData
     */
    private async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {

            if(event instanceof InitializeEvent) {
                if (event.swapType !== ChainSwapType.CHAIN) {
                    //Only process on-chain requests
                    continue;
                }

                const swapData = await event.swapData();

                if (!this.swapContract.areWeOfferer(swapData)) {
                    continue;
                }

                if (swapData.isPayIn()) {
                    //Only process requests that don't pay in from the program
                    continue;
                }

                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");
                const savedSwap = await this.storageManager.getData(paymentHash, event.sequence);

                const isSwapFound = savedSwap != null;
                if (isSwapFound) {
                    savedSwap.txIds.init = (event as any).meta?.txId;
                    if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();

                    if(savedSwap.state===FromBtcSwapState.CREATED) {
                        await savedSwap.setState(FromBtcSwapState.COMMITED);
                        savedSwap.data = swapData;
                        await this.storageManager.saveData(paymentHashBuffer.toString("hex"), event.sequence, savedSwap);
                    }
                }

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHashHex = event.paymentHash;
                const paymentHash: Buffer = Buffer.from(paymentHashHex, "hex");

                const savedSwap = await this.storageManager.getData(paymentHashHex, event.sequence);

                const isSwapNotFound = savedSwap == null;
                if (isSwapNotFound) {
                    continue;
                }

                savedSwap.txId = Buffer.from(event.secret, "hex").reverse().toString("hex");
                savedSwap.txIds.claim = (event as any).meta?.txId;
                if(savedSwap.metadata!=null) savedSwap.metadata.times.claimTxReceived = Date.now();

                await savedSwap.setState(FromBtcSwapState.CLAIMED);
                //await PluginManager.swapStateChange(savedSwap);

                console.log("[From BTC: Solana.ClaimEvent] Swap claimed by claimer: ", paymentHashHex);
                await this.removeSwapData(paymentHash.toString("hex"), event.sequence);

                continue;
            }
            if(event instanceof RefundEvent) {
                if (event.paymentHash == null) {
                    continue;
                }

                const savedSwap = await this.storageManager.getData(event.paymentHash, event.sequence);

                const isSwapNotFound = savedSwap == null;
                if (isSwapNotFound) {
                    continue;
                }

                savedSwap.txIds.refund = (event as any).meta?.txId;

                await savedSwap.setState(FromBtcSwapState.REFUNDED);
                await this.removeSwapData(event.paymentHash, event.sequence);

                continue;
            }
        }

        return true;
    }

    /**
     * Sets up required listeners for the REST server
     *
     * @param restServer
     */
    startRestServer(restServer: Express) {

        restServer.use(this.path+"/getAddress", serverParamDecoder(10*1000));
        restServer.post(this.path+"/getAddress", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to use
             * exactOut: boolean             Whether the swap should be an exact out instead of exact in swap
             * sequence: BN                 Unique sequence number for the swap
             *
             *Sent later
             * claimerBounty: object        Data for calculating claimer bounty
             *  - feePerBlock: string           Fee per block to be synchronized with btc relay
             *  - safetyFactor: number          Safety factor to multiply required blocks (when using 10 min block time)
             *  - startTimestamp: string        UNIX seconds used for timestamp delta calc
             *  - addBlock: number              Additional blocks to add to the calculation
             *  - addFee: string                Additional fee to add to the final claimer bounty
             * feeRate: string              Fee rate to be used for init signature
             */

            const parsedBody: FromBtcRequestType = await req.paramReader.getParams({
                address: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.swapContract.isValidAddress(val) ? val : null,
                amount: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                sequence: FieldTypeEnum.BN,
                exactOut: FieldTypeEnum.BooleanOptional
            });

            metadata.request = parsedBody;

            const responseStream = res.responseStream;

            if(parsedBody==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20100,
                    msg: "Invalid request body"
                });
                return;
            }

            if(parsedBody.sequence.isNeg() || parsedBody.sequence.gte(new BN(2).pow(new BN(64)))) {
                await responseStream.writeParamsAndEnd({
                    code: 20042,
                    msg: "Invalid sequence"
                });
                return;
            }

            const pluginResult = await PluginManager.onSwapRequestFromBtc(req, parsedBody, metadata);

            if(pluginResult.throw) {
                await responseStream.writeParamsAndEnd({
                    code: 29999,
                    msg: pluginResult.throw
                });
                return;
            }

            let baseFee = pluginResult.baseFee || this.config.baseFee;
            let feePPM = pluginResult.feePPM || this.config.feePPM;

            metadata.times.requestChecked = Date.now();

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            const abortController = new AbortController();
            const responseStreamAbortController = responseStream.getAbortSignal();
            responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));

            const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken).catch(e => {
                console.error("From BTC: REST.pricePrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;
            const securityDepositPricePrefetchPromise: Promise<BN> = parsedBody.token===this.swapContract.getNativeCurrencyAddress().toString() ?
                pricePrefetchPromise :
                (this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(this.swapContract.getNativeCurrencyAddress()).catch(e => {
                    console.error("From BTC: REST.securityDepositPrefetch", e);
                    abortController.abort(e);
                    return null;
                }) : null);

            let signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
                console.error("From BTC: REST.signDataPrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;

            const dummySwapData = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                null,
                null,
                null,
                null,
                new BN(0),
                this.config.confirmations,
                false,
                true,
                null,
                null
            );

            abortController.signal.throwIfAborted();

            let baseSDPromise: Promise<BN>;
            //Solana workaround
            if((this.swapContract as any).getRawRefundFee!=null) {
                baseSDPromise = (this.swapContract as any).getRawRefundFee(dummySwapData).catch(e => {
                    console.error("From BTC: REST.baseSDprefetch", e);
                    abortController.abort(e);
                    return null;
                });
            } else {
                baseSDPromise = this.swapContract.getRefundFee(dummySwapData).then(result => result.mul(new BN(2))).catch(e => {
                    console.error("From BTC: REST.baseSDprefetch", e);
                    abortController.abort(e);
                    return null;
                });
            }

            const balancePrefetch = this.swapContract.getBalance(useToken, true).catch(e => {
                console.error("From BTC: REST.balancePrefetch", e);
                abortController.abort(e);
                return null;
            });

            if(pricePrefetchPromise!=null) console.log("[From BTC: REST.payInvoice] Pre-fetching swap price!");
            if(signDataPrefetchPromise!=null) {
                signDataPrefetchPromise = signDataPrefetchPromise.then(val => val==null || abortController.signal.aborted ? null : responseStream.writeParams({
                    signDataPrefetch: val
                }).then(() => val)).catch(e => {
                    console.error("From BTC: REST.signDataPrefetch", e);
                    abortController.abort(e);
                    return null;
                });
                if(signDataPrefetchPromise!=null) console.log("[From BTC: REST.payInvoice] Pre-fetching signature data!");
            }

            let amountBD: BN;
            if(parsedBody.exactOut) {
                amountBD = await this.swapPricing.getToBtcSwapAmount(parsedBody.amount, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                abortController.signal.throwIfAborted();

                // amt = (amt+base_fee)/(1-fee)
                amountBD = amountBD.add(baseFee).mul(new BN(1000000)).div(new BN(1000000).sub(feePPM));

                if(amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                    let adjustedMin = this.config.min.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000)).sub(baseFee);
                    let adjustedMax = this.config.max.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000)).sub(baseFee);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    await responseStream.writeParamsAndEnd({
                        code: 20003,
                        msg: "Amount too low!",
                        data: {
                            min: minIn.toString(10),
                            max: maxIn.toString(10)
                        }
                    });
                    return;
                }

                if(amountBD.gt(this.config.max.mul(new BN(105)).div(new BN(100)))) {
                    let adjustedMin = this.config.min.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000)).sub(baseFee);
                    let adjustedMax = this.config.max.mul(new BN(1000000).sub(feePPM)).div(new BN(1000000)).sub(baseFee);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    await responseStream.writeParamsAndEnd({
                        code: 20004,
                        msg: "Amount too high!",
                        data: {
                            min: minIn.toString(10),
                            max: maxIn.toString(10)
                        }
                    });
                    return;
                }
            } else {
                amountBD = parsedBody.amount;

                if(amountBD.lt(this.config.min)) {
                    await responseStream.writeParamsAndEnd({
                        code: 20003,
                        msg: "Amount too low!",
                        data: {
                            min: this.config.min.toString(10),
                            max: this.config.max.toString(10)
                        }
                    });
                    return;
                }

                if(amountBD.gt(this.config.max)) {
                    await responseStream.writeParamsAndEnd({
                        code: 20004,
                        msg: "Amount too high!",
                        data: {
                            min: this.config.min.toString(10),
                            max: this.config.max.toString(10)
                        }
                    });
                    return;
                }
            }

            metadata.times.amountsChecked = Date.now();

            const swapFee = baseFee.add(amountBD.mul(feePPM).div(new BN(1000000)));
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

            abortController.signal.throwIfAborted();

            let amountInToken: BN;
            let total: BN;
            if(parsedBody.exactOut) {
                amountInToken = parsedBody.amount.add(swapFeeInToken);
                total = parsedBody.amount;
            } else {
                amountInToken = await this.swapPricing.getFromBtcSwapAmount(parsedBody.amount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                total = amountInToken.sub(swapFeeInToken);

                abortController.signal.throwIfAborted();
            }

            metadata.times.priceCalculated = Date.now();

            const balance = await balancePrefetch;

            abortController.signal.throwIfAborted();

            if(total.gt(balance)) {
                await responseStream.writeParamsAndEnd({
                    code: 20002,
                    msg: "Not enough liquidity"
                });
                return;
            }

            metadata.times.balanceChecked = Date.now();

            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: this.LND,
                format: "p2wpkh"
            });

            abortController.signal.throwIfAborted();

            metadata.times.addressCreated = Date.now();

            console.log("[From BTC: REST.CreateInvoice] Created receiving address: ", receiveAddress);

            const createdSwap: FromBtcSwapAbs<T> = new FromBtcSwapAbs<T>(receiveAddress, amountBD, swapFee);

            const paymentHash = this.getChainHash(createdSwap);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = this.config.swapTsCsvDelta;

            const expiry = currentTimestamp.add(expiryTimeout);

            //Calculate security deposit
            let baseSD: BN = await baseSDPromise;

            abortController.signal.throwIfAborted();

            metadata.times.refundFeeFetched = Date.now();

            console.log("[From BTC: REST.CreateInvoice] Base security deposit: ", baseSD.toString(10));
            const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(
                amountBD.sub(swapFee),
                this.swapContract.getNativeCurrencyAddress(),
                true,
                securityDepositPricePrefetchPromise==null ? null : await securityDepositPricePrefetchPromise
            );

            abortController.signal.throwIfAborted();

            console.log("[From BTC: REST.CreateInvoice] Swap output value in native currency: ", swapValueInNativeCurrency.toString(10));
            const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));
            console.log("[From BTC: REST.CreateInvoice] APY PPM: ", apyPPM.toString(10));
            console.log("[From BTC: REST.CreateInvoice] Expiry timeout: ", expiryTimeout.toString(10));
            const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);
            console.log("[From BTC: REST.CreateInvoice] Variable security deposit: ", variableSD.toString(10));
            const totalSecurityDeposit = baseSD.add(variableSD);

            const parsedClaimerBounty = await req.paramReader.getParams({
                claimerBounty: {
                    feePerBlock: FieldTypeEnum.BN,
                    safetyFactor: FieldTypeEnum.BN,
                    startTimestamp: FieldTypeEnum.BN,
                    addBlock: FieldTypeEnum.BN,
                    addFee: FieldTypeEnum.BN,
                },
            }).catch(e => null);

            abortController.signal.throwIfAborted();

            if(parsedClaimerBounty==null || parsedClaimerBounty.claimerBounty==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20043,
                    msg: "Invalid claimerBounty"
                });
                return;
            }

            //Calculate claimer bounty
            const tsDelta = expiry.sub(parsedClaimerBounty.claimerBounty.startTimestamp);
            const blocksDelta = tsDelta.div(this.config.bitcoinBlocktime).mul(parsedClaimerBounty.claimerBounty.safetyFactor);
            const totalBlock = blocksDelta.add(parsedClaimerBounty.claimerBounty.addBlock);
            const totalClaimerBounty = parsedClaimerBounty.claimerBounty.addFee.add(totalBlock.mul(parsedClaimerBounty.claimerBounty.feePerBlock));

            metadata.times.securityDepositCalculated = Date.now();

            const data: T = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                total,
                paymentHash.toString("hex"),
                parsedBody.sequence,
                expiry,
                new BN(0),
                this.config.confirmations,
                false,
                true,
                totalSecurityDeposit,
                totalClaimerBounty
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapCreated = Date.now();

            data.setTxoHash(this.getChainTxoHash(createdSwap).toString("hex"));

            createdSwap.data = data;

            const feeRateObj = await req.paramReader.getParams({
                feeRate: FieldTypeEnum.String
            }).catch(e => null);

            abortController.signal.throwIfAborted();

            const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;

            const sigData = await this.swapContract.getInitSignature(
                data,
                this.config.authorizationTimeout,
                signDataPrefetchPromise==null ? null : await signDataPrefetchPromise,
                feeRate
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapSigned = Date.now();
            createdSwap.metadata = metadata;
            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(this.getChainHash(createdSwap).toString("hex"), createdSwap.data.getSequence(), createdSwap);

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    btcAddress: receiveAddress,
                    address: this.swapContract.getAddress(),
                    swapFee: swapFeeInToken.toString(10),
                    total: total.toString(10),
                    data: data.serialize(),
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        }));

        console.log("[From BTC: REST] Started at path: ", this.path);
    }

    /**
     * Initializes chain events subscription
     */
    private subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC: Solana.Events] Subscribed to Solana events");
    }

    /**
     * Starts the checkPastSwaps watchdog
     */
    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps().catch( e => console.error(e));
            setTimeout(rerun, this.config.refundInterval);
        };
        await rerun();
    }

    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    async init() {
        await this.storageManager.loadData(FromBtcSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    /**
     * Returns swap handler info
     */
    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any, tokens: string[] } {
        return {
            swapFeePPM: this.config.feePPM.toNumber(),
            swapBaseFee: this.config.baseFee.toNumber(),
            min: this.config.min.toNumber(),
            max: this.config.max.toNumber(),
            data: {
                confirmations: this.config.confirmations,

                cltv: this.config.swapCsvDelta,
                timestampCltv: this.config.swapTsCsvDelta.toNumber()
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }
}
