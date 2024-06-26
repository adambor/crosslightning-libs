import * as BN from "bn.js";
import {Express} from "express";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
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
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import * as express from "express";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";

export type FromBtcLnConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    gracePeriod: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    invoiceTimeoutSeconds?: number,

    minCltv: BN,

    refundInterval: number,

    securityDepositAPY: number
}

const secondsInYear = new BN(365*24*60*60);

export type FromBtcLnRequestType = {
    address: string,
    paymentHash: string,
    amount: BN,
    token: string,
    descriptionHash?: string,
    exactOut?: boolean
}

/**
 * Swap handler handling from BTCLN swaps using submarine swaps
 */
export class FromBtcLnAbs<T extends SwapData> extends SwapHandler<FromBtcLnSwapAbs<T>, T> {

    readonly type = SwapHandlerType.FROM_BTCLN;

    readonly config: FromBtcLnConfig;

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcLnSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcLnConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, allowedTokens, lnd, swapPricing);
        this.config = config;
        this.config.invoiceTimeoutSeconds = this.config.invoiceTimeoutSeconds || 90;
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    private async checkPastSwaps() {

        const settleInvoices: FromBtcLnSwapAbs<T>[] = [];
        const cancelInvoices: string[] = [];
        const refundSwaps: FromBtcLnSwapAbs<T>[] = [];

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    FromBtcLnSwapState.CREATED,
                    FromBtcLnSwapState.RECEIVED,
                    FromBtcLnSwapState.COMMITED,
                    FromBtcLnSwapState.CLAIMED,
                    FromBtcLnSwapState.CANCELED,
                ]
            }
        ]);

        for(let swap of queriedData) {
            if(swap.state===FromBtcLnSwapState.CREATED) {
                //Check if already paid
                const parsedPR = bolt11.decode(swap.pr);
                const invoice = await lncli.getInvoice({
                    id: parsedPR.tagsObject.payment_hash,
                    lnd: this.LND
                });

                const isBeingPaid = invoice.is_held;
                if(isBeingPaid) {
                    //Adjust the state of the swap and expiry
                    try {
                        await this.htlcReceived(swap, invoice);
                        //Result is either FromBtcLnSwapState.RECEIVED or FromBtcLnSwapState.CANCELED
                    } catch (e) {
                        console.error(e);
                    }
                } else {
                    //Not paid
                    const isInvoiceExpired = parsedPR.timeExpireDate<Date.now()/1000;
                    if(isInvoiceExpired) {
                        await swap.setState(FromBtcLnSwapState.CANCELED);
                        // await PluginManager.swapStateChange(swap);
                        cancelInvoices.push(parsedPR.tagsObject.payment_hash);
                        continue;
                    }
                }

            }

            if(swap.state===FromBtcLnSwapState.RECEIVED) {
                const parsedPR = bolt11.decode(swap.pr);
                // console.log("[From BTC-LN: Swap received check] Swap in received state check for expiry: "+parsedPR.tagsObject.payment_hash);
                // console.log("[From BTC-LN: Swap received check] Swap signature: "+swap.signature);
                if(swap.signature!=null) {
                    const isAuthorizationExpired = await this.swapContract.isInitAuthorizationExpired(swap.data, swap.timeout, swap.prefix, swap.signature);
                    console.log("[From BTC-LN: Swap received check] Swap auth expired: "+parsedPR.tagsObject.payment_hash);
                    if(isAuthorizationExpired) {
                        const isCommited = await this.swapContract.isCommited(swap.data);
                        if(!isCommited) {
                            await swap.setState(FromBtcLnSwapState.CANCELED);
                            //await PluginManager.swapStateChange(swap);
                            cancelInvoices.push(parsedPR.tagsObject.payment_hash);
                        } else {
                            await swap.setState(FromBtcLnSwapState.COMMITED);
                            await this.storageManager.saveData(swap.data.getHash(), null, swap);
                        }
                        continue;
                    }
                }
            }

            if(swap.state===FromBtcLnSwapState.RECEIVED || swap.state===FromBtcLnSwapState.COMMITED) {
                const expiryTime = swap.data.getExpiry();
                const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

                const isExpired = expiryTime!=null && expiryTime.lt(currentTime);
                if(isExpired) {
                    const isCommited = await this.swapContract.isCommited(swap.data);

                    if(isCommited) {
                        refundSwaps.push(swap);
                        continue;
                    }

                    cancelInvoices.push(swap.data.getHash());
                    continue;
                }
            }

            if(swap.state===FromBtcLnSwapState.CLAIMED) {
                //Try to settle the hodl invoice
                settleInvoices.push(swap);
                continue;
            }

            if(swap.state===FromBtcLnSwapState.CANCELED) {
                cancelInvoices.push(swap.data.getHash());
                continue;
            }
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;

            await this.swapContract.refund(refundSwap.data, true, false, true);

            await refundSwap.setState(FromBtcLnSwapState.REFUNDED);
            // await PluginManager.swapStateChange(refundSwap);
            unlock();
        }

        for(let paymentHash of cancelInvoices) {
            //Refund
            try {
                await lncli.cancelHodlInvoice({
                    lnd: this.LND,
                    id: paymentHash
                });
                console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was timed out, id: ", paymentHash);
                await this.removeSwapData(paymentHash, null);
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash);
            }
        }

        for(let swap of settleInvoices) {
            //Refund
            const secretBuffer = Buffer.from(swap.secret, "hex");
            const paymentHash = createHash("sha256").update(secretBuffer).digest();

            try {
                await lncli.settleHodlInvoice({
                    lnd: this.LND,
                    secret: swap.secret
                });

                if(swap.metadata!=null) swap.metadata.times.htlcSettled = Date.now();

                await swap.setState(FromBtcLnSwapState.SETTLED);
                // await PluginManager.swapStateChange(swap);

                console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHash.toString("hex"));
                await this.removeSwapData(paymentHash.toString("hex"), null);
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] Cannot settle hodl invoice id: ", paymentHash.toString("hex"));
            }
        }
    }

    /**
     * Chain event handler
     *
     * @param eventData
     */
    private async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                if (event.swapType !== ChainSwapType.HTLC) {
                    //Only process HTLC requests
                    continue;
                }

                const swapData = await event.swapData();

                if (!this.swapContract.areWeOfferer(swapData)) {
                    continue;
                }

                if (swapData.isPayIn()) {
                    continue;
                }

                //Increment nonce
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");

                const savedSwap = await this.storageManager.getData(paymentHash, null);

                const isSwapFound = savedSwap != null;
                if (isSwapFound) {
                    savedSwap.txIds.init = (event as any).meta?.txId;
                    if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();

                    if(savedSwap.state===FromBtcLnSwapState.CREATED) {
                        await savedSwap.setState(FromBtcLnSwapState.COMMITED);
                        // await PluginManager.swapStateChange(savedSwap);
                        savedSwap.data = swapData;
                        await this.storageManager.saveData(paymentHashBuffer.toString("hex"), null, savedSwap);
                    }
                }

            }
            if(event instanceof ClaimEvent) {
                //Claim
                //This is the important part, we need to catch the claim TX, else we may lose money
                const secret: Buffer = Buffer.from(event.secret, "hex");
                const paymentHash: Buffer = createHash("sha256").update(secret).digest();

                const secretHex = secret.toString("hex");
                const paymentHashHex = paymentHash.toString("hex");

                const savedSwap = await this.storageManager.getData(paymentHashHex, null);

                const isSwapFound = savedSwap != null;
                if (!isSwapFound) {
                    continue;
                }

                savedSwap.txIds.claim = (event as any).meta?.txId;

                if(savedSwap.metadata!=null) savedSwap.metadata.times.claimTxReceived = Date.now();

                try {
                    await lncli.settleHodlInvoice({
                        lnd: this.LND,
                        secret: secretHex
                    });
                    console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHashHex);
                    savedSwap.secret = secretHex;
                    if(savedSwap.metadata!=null) savedSwap.metadata.times.htlcSettled = Date.now();
                    await savedSwap.setState(FromBtcLnSwapState.SETTLED);
                    // await PluginManager.swapStateChange(savedSwap);
                    await this.removeSwapData(paymentHashHex, null);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] FATAL Cannot settle hodl invoice id: " + paymentHashHex + " secret: ", secretHex);
                    savedSwap.secret = secretHex;
                    await savedSwap.setState(FromBtcLnSwapState.CLAIMED);
                    //await PluginManager.swapStateChange(savedSwap);
                    await this.storageManager.saveData(paymentHashHex, null, savedSwap);
                }

                continue;
            }
            if(event instanceof RefundEvent) {
                //Refund
                //Try to get the hash from the refundMap
                if (event.paymentHash == null) {
                    continue;
                }

                const paymentHashBuffer: Buffer = Buffer.from(event.paymentHash, "hex");

                const savedSwap = await this.storageManager.getData(event.paymentHash, null);

                const isSwapFound = savedSwap != null;
                if (!isSwapFound) {
                    continue;
                }

                savedSwap.txIds.refund = (event as any).meta?.txId;

                try {
                    await lncli.cancelHodlInvoice({
                        lnd: this.LND,
                        id: event.paymentHash
                    });
                    console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was refunded, id: ", event.paymentHash);
                    await savedSwap.setState(FromBtcLnSwapState.REFUNDED);
                    // await PluginManager.swapStateChange(savedSwap);
                    await this.removeSwapData(event.paymentHash, null);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", event.paymentHash);
                    await savedSwap.setState(FromBtcLnSwapState.CANCELED);
                    // await PluginManager.swapStateChange(savedSwap);
                    await this.storageManager.saveData(event.paymentHash, null, savedSwap);
                }

                continue;
            }
        }

        return true;
    }

    /**
     * Saves the state of received HTLC of the lightning payment
     *
     * @param invoiceData
     * @param invoice
     */
    private async htlcReceived(invoiceData: FromBtcLnSwapAbs<T>, invoice: any) {
        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcReceived = Date.now();

        const useToken: TokenAddress = invoiceData.data.getToken();

        // const invoiceAmount: BN = new BN(invoice.received);
        // const fee: BN = invoiceData.swapFee;
        //
        // const invoiceAmountInToken = await this.swapPricing.getFromBtcSwapAmount(invoiceAmount, useToken);
        // const feeInToken = await this.swapPricing.getFromBtcSwapAmount(fee, useToken, true);
        //
        // const sendAmount: BN = invoiceAmountInToken.sub(feeInToken);

        const sendAmount: BN = invoiceData.data.getAmount();

        const abortController = new AbortController();

        const balancePrefetch: Promise<BN> = this.swapContract.getBalance(useToken, true).catch(e => {
            console.error("From BTC-LN: HTLC-Received.balancePrefetch", e);
            abortController.abort(e);
            return null;
        });
        const blockheightPrefetch = lncli.getHeight({lnd: this.LND}).catch(e => {
            console.error("From BTC-LN: HTLC-Received.blockheightPrefetch", e);
            abortController.abort(e);
            return null;
        });
        const signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
            console.error("From BTC-LN: HTLC-Received.signDataPrefetch", e);
            abortController.abort(e);
            return null;
        }) : null;

        const cancelAndRemove = async () => {
            if(invoiceData.state!==FromBtcLnSwapState.CREATED) return;
            await invoiceData.setState(FromBtcLnSwapState.CANCELED);
            // await PluginManager.swapStateChange(invoiceData);
            await lncli.cancelHodlInvoice({
                id: invoice.id,
                lnd: this.LND
            });
            await this.removeSwapData(invoice.id, null);
        };

        const balance: BN = await balancePrefetch;

        abortController.signal.throwIfAborted();

        const hasEnoughBalance = balance!=null && balance.gte(sendAmount);
        if (!hasEnoughBalance) {
            await cancelAndRemove();
            console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] ERROR Not enough balance on smart chain to honor the request");
            throw {
                code: 20001,
                msg: "Not enough liquidity"
            };
        }

        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcBalanceChecked = Date.now();

        let timeout: number = null;
        invoice.payments.forEach((curr) => {
            if (timeout == null || timeout > curr.timeout) timeout = curr.timeout;
        });
        const {current_block_height} = await blockheightPrefetch;

        abortController.signal.throwIfAborted();

        const blockDelta = new BN(timeout - current_block_height);

        const htlcExpiresTooSoon = blockDelta.lt(this.config.minCltv);
        if(htlcExpiresTooSoon) {
            await cancelAndRemove();
            console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] Receive HTLC expires too soon (required: "+this.config.minCltv.toString(10)+", got: "+blockDelta.toString(10)+")");
            throw {
                code: 20002,
                msg: "Not enough time to reliably process the swap"
            };
        }

        console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] using cltv delta: ", this.config.minCltv.toString(10));

        const expiryTimeout = this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);

        console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] expiry timeout: ", expiryTimeout.toString(10));

        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcTimeoutCalculated = Date.now();

        const payInvoiceObject: T = await this.swapContract.createSwapData(
            ChainSwapType.HTLC,
            this.swapContract.getAddress(),
            invoice.description,
            useToken,
            sendAmount,
            invoice.id,
            new BN(0),
            new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout),
            new BN(0),
            0,
            false,
            true,
            invoiceData.data.getSecurityDeposit(),
            new BN(0)
        );

        abortController.signal.throwIfAborted();

        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcSwapCreated = Date.now();

        const sigData = await this.swapContract.getInitSignature(
            payInvoiceObject,
            this.config.authorizationTimeout,
            signDataPrefetchPromise==null ? null : await signDataPrefetchPromise,
            invoiceData.feeRate
        );

        //No need to check abortController anymore since all pending promises are resolved by now

        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcSwapSigned = Date.now();

        //Important to prevent race condition and issuing 2 signed init messages at the same time
        if(invoiceData.state===FromBtcLnSwapState.CREATED) {
            invoiceData.data = payInvoiceObject;

            invoiceData.prefix = sigData.prefix;
            invoiceData.timeout = sigData.timeout;
            invoiceData.signature = sigData.signature;

            //Setting the state variable is done outside the promise, so is done synchronously
            await invoiceData.setState(FromBtcLnSwapState.RECEIVED);

            await this.storageManager.saveData(invoice.id, null, invoiceData);
            return;
        }
    }

    startRestServer(restServer: Express) {

        restServer.use(this.path+"/createInvoice", serverParamDecoder(10*1000));
        restServer.post(this.path+"/createInvoice", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                invoiceRequest?: any,
                invoiceResponse?: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             * address: string              solana address of the recipient
             * paymentHash: string          payment hash of the to-be-created invoice
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to swap
             * exactOut: boolean            Whether the swap should be an exact out instead of exact in swap
             * descriptionHash: string      Description hash of the invoice
             *
             *Sent later:
             * feeRate: string              Fee rate to use for the init signature
             */

            const parsedBody: FromBtcLnRequestType = await req.paramReader.getParams({
                address: (val: string) => val!=null &&
                            typeof(val)==="string" &&
                            this.swapContract.isValidAddress(val) ? val : null,
                paymentHash: (val: string) => val!=null &&
                            typeof(val)==="string" &&
                            val.length===64 &&
                            HEX_REGEX.test(val) ? val: null,
                amount: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                descriptionHash: FieldTypeEnum.StringOptional,
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

            if(parsedBody.descriptionHash!=null) {
                if(typeof(parsedBody.descriptionHash)!=="string" || !HEX_REGEX.test(parsedBody.descriptionHash) || parsedBody.descriptionHash.length!==64) {
                    await responseStream.writeParamsAndEnd({
                        code: 20100,
                        msg: "Invalid request body"
                    });
                    return;
                }
            }

            const pluginResult = await PluginManager.onSwapRequestFromBtcLn(req, parsedBody, metadata);

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
                console.error("From BTC-LN: REST.pricePrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;
            const securityDepositPricePrefetchPromise: Promise<BN> = parsedBody.token===this.swapContract.getNativeCurrencyAddress().toString() ?
                pricePrefetchPromise :
                (this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(this.swapContract.getNativeCurrencyAddress()).catch(e => {
                    console.error("From BTC-LN: REST.securityDepositPrefetch", e);
                    abortController.abort(e);
                    return null;
                }) : null);

            const balancePrefetch: Promise<BN> = this.swapContract.getBalance(useToken, true).catch(e => {
                console.error("From BTC-LN: REST.balancePrefetch", e);
                abortController.abort(e);
                return null;
            });

            const channelsPrefetch: Promise<{channels: any[]}> = lncli.getChannels({is_active: true, lnd: this.LND}).catch(e => {
                console.error("From BTC-LN: REST.channelsPrefetch", e);
                abortController.abort(e);
                return null;
            });

            const dummySwapData = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                null,
                parsedBody.paymentHash,
                new BN(0),
                null,
                null,
                0,
                false,
                true,
                null,
                new BN(0)
            );

            abortController.signal.throwIfAborted();

            let baseSDPromise: Promise<BN>;
            //Solana workaround
            if((this.swapContract as any).getRawRefundFee!=null) {
                baseSDPromise = (this.swapContract as any).getRawRefundFee(dummySwapData).catch(e => {
                    console.error("From BTC-LN: REST.baseSDPrefetch", e);
                    abortController.abort(e);
                    return null;
                });
            } else {
                baseSDPromise = this.swapContract.getRefundFee(dummySwapData).then(result => result.mul(new BN(2))).catch(e => {
                    console.error("From BTC-LN: REST.baseSDPrefetch", e);
                    abortController.abort(e);
                    return null;
                });
            }

            if(pricePrefetchPromise!=null) console.log("[From BTC-LN: REST.payInvoice] Pre-fetching swap price!");

            lncli.getWalletInfo({lnd: this.LND}).then(resp => responseStream.writeParams({
                lnPublicKey: resp.public_key
            })).catch(e => {
                console.error("From BTC-LN: REST.getWalletInfo", e);
            });

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

            // if(parsedBody.expiry<=0) {
            //     await responseStream.writeParamsAndEnd({
            //         msg: "Invalid request body (expiry)"
            //     });
            //     return;
            // }
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

            if(balance==null || balance.lt(total)) {
                await responseStream.writeParamsAndEnd({
                    code: 20002,
                    msg: "Not enough liquidity"
                });
                return;
            }

            const channelsResponse = await channelsPrefetch;

            abortController.signal.throwIfAborted();

            let hasEnoughInboundLiquidity = false;
            channelsResponse.channels.forEach(channel => {
                if(new BN(channel.remote_balance).gte(amountBD)) hasEnoughInboundLiquidity = true;
            });
            if(!hasEnoughInboundLiquidity) {
                await responseStream.writeParamsAndEnd({
                    code: 20050,
                    msg: "Not enough LN inbound liquidity"
                });
                return;
            }

            metadata.times.balanceChecked = Date.now();

            const hodlInvoiceObj: any = {
                description: parsedBody.address,
                cltv_delta: this.config.minCltv.add(new BN(5)).toString(10),
                expires_at: new Date(Date.now()+(this.config.invoiceTimeoutSeconds*1000)).toISOString(),
                id: parsedBody.paymentHash,
                tokens: amountBD.toString(10),
                description_hash: parsedBody.descriptionHash
            };

            metadata.invoiceRequest = {...hodlInvoiceObj};

            console.log("[From BTC-LN: REST.CreateInvoice] creating hodl invoice: ", hodlInvoiceObj);

            hodlInvoiceObj.lnd = this.LND;

            const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);

            abortController.signal.throwIfAborted();

            metadata.times.invoiceCreated = Date.now();
            metadata.invoiceResponse = {...hodlInvoice};

            console.log("[From BTC-LN: REST.CreateInvoice] hodl invoice created: ", hodlInvoice);

            const createdSwap = new FromBtcLnSwapAbs<T>(hodlInvoice.request, swapFee);

            //Pre-compute the security deposit
            const expiryTimeout = this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);

            let baseSD: BN = await baseSDPromise;

            abortController.signal.throwIfAborted();

            metadata.times.refundFeeFetched = Date.now();

            const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(
                amountBD.sub(swapFee),
                this.swapContract.getNativeCurrencyAddress(),
                true,
                securityDepositPricePrefetchPromise==null ? null : await securityDepositPricePrefetchPromise
            );

            abortController.signal.throwIfAborted();

            const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));
            const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);

            const totalSecurityDeposit = baseSD.add(variableSD);

            metadata.times.securityDepositCalculated = Date.now();

            createdSwap.data = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                total,
                parsedBody.paymentHash,
                new BN(0),
                null,
                null,
                0,
                false,
                true,
                totalSecurityDeposit,
                new BN(0)
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapCreated = Date.now();
            createdSwap.metadata = metadata;

            const feeRateObj = await req.paramReader.getParams({
                feeRate: FieldTypeEnum.String
            }).catch(e => null);

            abortController.signal.throwIfAborted();

            createdSwap.feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(parsedBody.paymentHash, null, createdSwap);

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFeeInToken.toString(10),
                    total: total.toString(10),
                    intermediaryKey: this.swapContract.getAddress(),
                    securityDeposit: totalSecurityDeposit.toString(10)
                }
            });

        }));

        const getInvoiceStatus = expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            const parsedBody = verifySchema({...req.body, ...req.query}, {
                paymentHash: (val: string) => val!=null &&
                typeof(val)==="string" &&
                val.length===64 &&
                HEX_REGEX.test(val) ? val: null,
            });

            const invoice = await lncli.getInvoice({
                id: parsedBody.paymentHash,
                lnd: this.LND
            });

            const isInvoiceFound = invoice!=null;
            if(!isInvoiceFound) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if(!this.swapContract.isValidAddress(invoice.description)) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            const isBeingPaid = invoice.is_held;
            if (!isBeingPaid) {
                if (invoice.is_canceled) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                } else if (invoice.is_confirmed) {
                    res.status(200).json({
                        code: 10002,
                        msg: "Invoice already paid"
                    });
                } else {
                    res.status(200).json({
                        code: 10003,
                        msg: "Invoice yet unpaid"
                    });
                }
            }

            res.status(200).json({
                code: 10000,
                msg: "Success"
            });

        });

        restServer.post(this.path+"/getInvoiceStatus", getInvoiceStatus);
        restServer.get(this.path+"/getInvoiceStatus", getInvoiceStatus);

        const getInvoicePaymentAuth = expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            const parsedBody = verifySchema({...req.body, ...req.query}, {
                paymentHash: (val: string) => val!=null &&
                typeof(val)==="string" &&
                val.length===64 &&
                HEX_REGEX.test(val) ? val: null,
            });

            const invoice = await lncli.getInvoice({
                id: parsedBody.paymentHash,
                lnd: this.LND
            });

            const isInvoiceFound = invoice!=null;
            if (!isInvoiceFound) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (!this.swapContract.isValidAddress(invoice.description)) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            const isBeingPaid = invoice.is_held;
            if (!isBeingPaid) {
                if (invoice.is_canceled) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                } else if (invoice.is_confirmed) {
                    res.status(200).json({
                        code: 10002,
                        msg: "Invoice already paid"
                    });
                } else {
                    res.status(200).json({
                        code: 10003,
                        msg: "Invoice yet unpaid"
                    });
                }
                return;
            }

            const invoiceData: FromBtcLnSwapAbs<T> = await this.storageManager.getData(parsedBody.paymentHash, null);

            const isSwapFound = invoiceData != null;
            if (!isSwapFound) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (invoiceData.state === FromBtcLnSwapState.RECEIVED) {
                if (invoiceData.signature!=null && await this.swapContract.isInitAuthorizationExpired(invoiceData.data, invoiceData.timeout, invoiceData.prefix, invoiceData.signature)) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }
            }

            if (invoiceData.state === FromBtcLnSwapState.CREATED) {
                console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] held ln invoice: ", invoice);

                try {
                    await this.htlcReceived(invoiceData, invoice);
                } catch (e) {
                    res.status(200).json(e);
                    return;
                }
            }

            if (invoiceData.state === FromBtcLnSwapState.CANCELED) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (invoiceData.state === FromBtcLnSwapState.COMMITED) {
                res.status(200).json({
                    code: 10004,
                    msg: "Invoice already committed"
                });
                return;
            }

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    address: this.swapContract.getAddress(),
                    data: invoiceData.serialize().data,
                    nonce: invoiceData.nonce,
                    prefix: invoiceData.prefix,
                    timeout: invoiceData.timeout,
                    signature: invoiceData.signature
                }
            });
        });

        restServer.post(this.path+"/getInvoicePaymentAuth", getInvoicePaymentAuth);
        restServer.get(this.path+"/getInvoicePaymentAuth", getInvoicePaymentAuth);

        console.log("[From BTC-LN: REST] Started at path: ", this.path);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps().catch( e => console.error(e));
            setTimeout(rerun, this.config.refundInterval);
        };
        await rerun();
    }

    async init() {
        await this.storageManager.loadData(FromBtcLnSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any, tokens: string[] } {
        return {
            swapFeePPM: this.config.feePPM.toNumber(),
            swapBaseFee: this.config.baseFee.toNumber(),
            min: this.config.min.toNumber(),
            max: this.config.max.toNumber(),
            data: {
                minCltv: this.config.minCltv.toNumber()
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }

}

