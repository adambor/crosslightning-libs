import * as BN from "bn.js";
import {Express} from "express";
import * as bolt11 from "bolt11";
import * as lncli from "ln-service";
import {ToBtcLnSwapAbs, ToBtcLnSwapState} from "./ToBtcLnSwapAbs";
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
import {SwapNonce} from "../SwapNonce";
import {AuthenticatedLnd} from "lightning";
import {expressHandlerWrapper, FieldTypeEnum, HEX_REGEX, verifySchema} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";

export type ToBtcLnConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    gracePeriod: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    routingFeeMultiplier: BN,

    minSendCltv: BN,

    swapCheckInterval: number,

    allowProbeFailedSwaps: boolean,
    allowShortExpiry: boolean,

    minLnRoutingFeePPM?: BN,
    minLnBaseFee?: BN
};

const SNOWFLAKE_LIST: Set<string> = new Set([
    "038f8f113c580048d847d6949371726653e02b928196bad310e3eda39ff61723f6"
]);

/**
 * Swap handler handling to BTCLN swaps using submarine swaps
 */
export class ToBtcLnAbs<T extends SwapData> extends SwapHandler<ToBtcLnSwapAbs<T>, T> {

    activeSubscriptions: Set<string> = new Set<string>();

    readonly type = SwapHandlerType.TO_BTCLN;

    readonly config: ToBtcLnConfig & {minTsSendCltv: BN};

    constructor(
        storageDirectory: IStorageManager<ToBtcLnSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any>,
        chainEvents: ChainEvents<T>,
        swapNonce: SwapNonce,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: ToBtcLnConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, swapNonce, allowedTokens, lnd, swapPricing);
        const anyConfig = config as any;
        anyConfig.minTsSendCltv = config.gracePeriod.add(config.bitcoinBlocktime.mul(config.minSendCltv).mul(config.safetyFactor));
        this.config = anyConfig;
        this.config.minLnRoutingFeePPM = this.config.minLnRoutingFeePPM || new BN(1000);
        this.config.minLnBaseFee = this.config.minLnBaseFee || new BN(5);
    }

    /**
     * Checks past swaps, deletes ones that are already expired, and tries to process ones that are committed.
     */
    private async checkPastInvoices() {

        for(let key in this.storageManager.data) {
            const invoiceData: ToBtcLnSwapAbs<T> = this.storageManager.data[key];
            const decodedPR = bolt11.decode(invoiceData.pr);

            if (invoiceData.state === ToBtcLnSwapState.SAVED) {
                //Current timestamp plus maximum allowed on-chain time skew
                const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew));

                const isSignatureExpired = invoiceData.signatureExpiry!=null && invoiceData.signatureExpiry.lt(timestamp);
                if(isSignatureExpired) {
                    await invoiceData.setState(ToBtcLnSwapState.CANCELED);
                    await this.removeSwapData(invoiceData.getHash());
                    continue;
                }

                //Yet unpaid
                const isInvoiceExpired = decodedPR.timeExpireDate < Date.now() / 1000;
                if (isInvoiceExpired) {
                    //Expired
                    await invoiceData.setState(ToBtcLnSwapState.CANCELED);
                    await this.removeSwapData(invoiceData.getHash());
                    continue;
                }
            }

            if (invoiceData.state === ToBtcLnSwapState.COMMITED || invoiceData.state === ToBtcLnSwapState.PAID) {
                await this.processInitialized(invoiceData, invoiceData.data);
            }
        }
    }

    /**
     * Process the result of attempted lightning network payment
     *
     * @param invoiceData
     * @param lnPaymentStatus
     */
    private async processPaymentResult(invoiceData: ToBtcLnSwapAbs<T>, lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, is_pending?: boolean, payment?: any}) {
        const decodedPR = bolt11.decode(invoiceData.pr);

        if(lnPaymentStatus.is_failed) {
            console.error("[To BTC-LN: BTCLN.PaymentResult] Invoice payment failed, should refund offerer");
            await invoiceData.setState(ToBtcLnSwapState.CANCELED);
            //await PluginManager.swapStateChange(invoiceData);
            await this.removeSwapData(decodedPR.tagsObject.payment_hash);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            return;
        }

        if(lnPaymentStatus.is_confirmed) {
            invoiceData.secret = lnPaymentStatus.payment.secret;
            invoiceData.realRoutingFee = new BN(lnPaymentStatus.payment.fee_mtokens).div(new BN(1000));
            await invoiceData.setState(ToBtcLnSwapState.PAID);
            // await PluginManager.swapStateChange(invoiceData);
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData);

            //Check if escrow state exists
            const isCommited = await this.swapContract.isCommited(invoiceData.data);

            if(!isCommited) {
                console.error("[To BTC-LN: BTCLN.PaymentResult] Tried to claim but escrow doesn't exist anymore: ", decodedPR.tagsObject.payment_hash);
                return;
            }

            //Set flag that we are sending the transaction already, so we don't end up with race condition
            const unlock: () => boolean = invoiceData.lock(this.swapContract.claimWithSecretTimeout);
            if(unlock==null) return;

            const success = await this.swapContract.claimWithSecret(invoiceData.data, lnPaymentStatus.payment.secret, false, false, true);

            if(success) {
                await invoiceData.setState(ToBtcLnSwapState.CLAIMED);
                // await PluginManager.swapStateChange(invoiceData);
                await this.removeSwapData(decodedPR.tagsObject.payment_hash);
            }
            unlock();

            return;
        }

        throw new Error("Invalid lnPaymentStatus");
    }

    /**
     * Subscribe to a pending lightning network payment attempt
     *
     * @param invoiceData
     */
    private subscribeToPayment(invoiceData: ToBtcLnSwapAbs<T>) {

        const decodedPR = bolt11.decode(invoiceData.pr);
        if(this.activeSubscriptions.has(decodedPR.tagsObject.payment_hash)) {
            //Already subscribed
            return;
        }

        const sub = lncli.subscribeToPastPayment({id: decodedPR.tagsObject.payment_hash, lnd: this.LND});

        console.log("[To BTC-LN: BTCLN.PaymentResult] Subscribed to payment: ", decodedPR.tagsObject.payment_hash);

        const onResult = (lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, payment?: any}) => {
            this.processPaymentResult(invoiceData, lnPaymentStatus).catch(e => console.error(e));
            sub.removeAllListeners();
            this.activeSubscriptions.delete(decodedPR.tagsObject.payment_hash);
        };

        sub.on('confirmed', (payment) => {
            const lnPaymentStatus = {
                is_confirmed: true,
                payment
            };

            console.log("[To BTC-LN: BTCLN.PaymentResult] Invoice paid, result: ", payment);

            onResult(lnPaymentStatus);
        });

        sub.on('failed', (payment) => {
            const lnPaymentStatus = {
                is_failed: true
            };

            console.log("[To BTC-LN: BTCLN.PaymentResult] Invoice pay failed, result: ", payment);

            onResult(lnPaymentStatus);
        });

        this.activeSubscriptions.add(decodedPR.tagsObject.payment_hash);

    }

    /**
     * Begins a lightning network payment attempt, if not attempted already
     *
     * @param invoiceData
     * @param data
     */
    private async processInitialized(invoiceData: ToBtcLnSwapAbs<T>, data: T) {

        const lnPr = invoiceData.pr;
        const decodedPR = bolt11.decode(lnPr);

        //Check if payment was already made
        let lnPaymentStatus = await lncli.getPayment({
            id: decodedPR.tagsObject.payment_hash,
            lnd: this.LND
        }).catch(e => {
            console.error(e);
        });

        if(invoiceData.metadata!=null) invoiceData.metadata.times.payPaymentChecked = Date.now();

        const markAsNonPayable = async() => {
            invoiceData.data = data;
            await invoiceData.setState(ToBtcLnSwapState.NON_PAYABLE);
            // await PluginManager.swapStateChange(invoiceData);
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData);
        };

        const paymentExists = lnPaymentStatus!=null;
        if(!paymentExists) {
            if (!data.isToken(invoiceData.data.getToken())) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid token used");
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] Struct: ", data);

            //const tokenAmount: BN = data.getAmount();
            const expiryTimestamp: BN = data.getExpiry();
            const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));

            console.log("[To BTC-LN: Solana.Initialize] Expiry time: ", expiryTimestamp.toString(10));

            const hasEnoughTimeToPay = expiryTimestamp.sub(currentTimestamp).gte(this.config.minTsSendCltv);
            if(!hasEnoughTimeToPay) {
                console.error("[To BTC-LN: Solana.Initialize] Not enough time to reliably pay the invoice");
                await markAsNonPayable();
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] lightning payment request: ", lnPr);
            console.log("[To BTC-LN: Solana.Initialize] Decoded lightning payment request: ", decodedPR);

            if(decodedPR.satoshis==null) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid invoice with no amount");
                await markAsNonPayable();
                return;
            }

            const amountBD = new BN(decodedPR.satoshis);

            if(amountBD.lt(this.config.min)) {
                console.error("[To BTC-LN: Solana.Initialize] Low payment amount: "+amountBD.toString(10)+" minimum: "+this.config.min.toString(10));
                await markAsNonPayable();
                return;
            }
            if(amountBD.gt(this.config.max)) {
                console.error("[To BTC-LN: Solana.Initialize] High payment amount: "+amountBD.toString(10)+" maximum: "+this.config.max.toString(10));
                await markAsNonPayable();
                return;
            }

            const maxFee = invoiceData.maxFee;

            const maxUsableCLTVdelta = expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

            console.log("[To BTC-LN: Solana.Initialize] Max usable CLTV expiry delta: ", maxUsableCLTVdelta.toString(10));
            console.log("[To BTC-LN: Solana.Initialize] Max fee: ", maxFee.toString(10));

            const isInvoiceExpired = decodedPR.timeExpireDate < Date.now() / 1000;
            if (isInvoiceExpired) {
                //Expired
                console.error("[To BTC-LN: Solana.Initialize] Invoice already expired!");
                await markAsNonPayable();
                return;
            }

            invoiceData.data = data;
            await invoiceData.setState(ToBtcLnSwapState.COMMITED);
            // await PluginManager.swapStateChange(invoiceData);
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData);

            const { current_block_height } = await lncli.getHeight({lnd: this.LND});

            const obj: any = {
                request: lnPr,
                max_fee: maxFee.toString(10),
                max_timeout_height: new BN(current_block_height).add(maxUsableCLTVdelta).toString(10)
            };

            console.log("[To BTC-LN: Solana.Initialize] Paying invoice: ", obj);

            obj.lnd = this.LND;

            const payment = await lncli.pay(obj).catch(e => {
                console.error(e);
            });

            if(invoiceData.metadata!=null) invoiceData.metadata.times.payComplete = Date.now();

            if(payment==null) {
                console.error("[To BTC-LN: Solana.Initialize] Failed to initiate invoice payment!");
                await markAsNonPayable();
                return;
            }

            this.subscribeToPayment(invoiceData);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            this.subscribeToPayment(invoiceData);
            return;
        }

        await this.processPaymentResult(invoiceData, lnPaymentStatus);

    }

    /**
     * Chain event handler
     *
     * @param eventData
     */
    private async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                console.log("Initialize Event: ", event);

                if(!this.swapContract.areWeClaimer(event.swapData)) {
                    continue;
                }

                if(event.swapData.getType()!==ChainSwapType.HTLC) {
                    //Only process ln requests
                    continue;
                }

                if(event.swapData.isPayOut()) {
                    //Only process requests that don't payout from the program
                    continue;
                }

                if(event.swapData.isPayIn()) {
                    const tokenAdress = event.swapData.getToken().toString();
                    const usedNonce = event.signatureNonce;
                    if (usedNonce > this.nonce.getClaimNonce(tokenAdress)) {
                        await this.nonce.saveClaimNonce(tokenAdress, usedNonce);
                    }
                }

                const paymentHash = event.paymentHash;

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.Initialize] No invoice submitted: ", paymentHash);
                    continue;
                }

                if(savedInvoice.metadata!=null) savedInvoice.metadata.times.txReceived = Date.now();

                console.log("[To BTC-LN: Solana.Initialize] SOL request submitted: ", paymentHash);

                await this.processInitialized(savedInvoice, event.swapData);

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(event.paymentHash, "hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.ClaimEvent] No invoice submitted: ", paymentHash);
                    continue;
                }

                console.log("[To BTC-LN: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await savedInvoice.setState(ToBtcLnSwapState.CLAIMED);
                await this.removeSwapData(paymentHash);

                continue;
            }
            if(event instanceof RefundEvent) {
                const paymentHash = event.paymentHash;

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.RefundEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC-LN: Solana.RefundEvent] Transaction refunded! Event: ", event);

                await savedInvoice.setState(ToBtcLnSwapState.REFUNDED);

                await this.removeSwapData(paymentHash);

                continue;
            }
        }

        return true;

    }

    startRestServer(restServer: Express) {
        restServer.post(this.path+"/payInvoice", expressHandlerWrapper(async (req, res) => {
            const metadata: {
                request: any,
                probeRequest?: any,
                probeResponse?: any,
                routeResponse?: any,
                times: {[key: string]: number}
            } = {request: req.body, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             * pr: string                   bolt11 lightning invoice
             * maxFee: string               maximum routing fee
             * expiryTimestamp: string      expiry timestamp of the to be created HTLC, determines how many LN paths can be considered
             * token: string                Desired token to use
             * offerer: string              Address of the caller
             */
            const parsedBody = verifySchema(req.body, {
                pr: FieldTypeEnum.String,
                maxFee: FieldTypeEnum.BN,
                expiryTimestamp: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                offerer: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.swapContract.isValidAddress(val) ? val : null
            });

            if (parsedBody==null) {
                res.status(400).json({
                    msg: "Invalid request body"
                });
                return;
            }

            if(parsedBody.maxFee.isNeg() || parsedBody.maxFee.isZero()) {
                res.status(400).json({
                    msg: "Invalid request body (maxFee too low)!"
                });
                return;
            }

            let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

            try {
                parsedPR = bolt11.decode(parsedBody.pr);
            } catch (e) {
                console.error(e);
                res.status(400).json({
                    msg: "Invalid request body (pr - cannot be parsed)"
                });
                return;
            }

            let halfConfidence = false;
            if(parsedPR.timeExpireDate < ((Date.now()/1000)+(this.config.authorizationTimeout+(2*60)))) {
                if(!this.config.allowShortExpiry) {
                    res.status(400).json({
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                } else if(parsedPR.timeExpireDate < Date.now()/1000) {
                    res.status(400).json({
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                }
                halfConfidence = true;
            }

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));

            const expiresTooSoon = parsedBody.expiryTimestamp.sub(currentTimestamp).lt(this.config.minTsSendCltv);
            if(expiresTooSoon) {
                res.status(400).json({
                    code: 20001,
                    msg: "Expiry time too low!"
                });
                return;
            }

            const amountBD = new BN(parsedPR.satoshis);

            if(amountBD.lt(this.config.min)) {
                res.status(400).json({
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
                res.status(400).json({
                    code: 20004,
                    msg: "Amount too high!",
                    data: {
                        min: this.config.min.toString(10),
                        max: this.config.max.toString(10)
                    }
                });
                return;
            }

            metadata.times.requestChecked = Date.now();

            //Check if prior payment has been made
            try {
                const payment = await lncli.getPayment({
                    lnd: this.LND,
                    id: parsedPR.tagsObject.payment_hash
                });

                if(payment!=null) {
                    res.status(400).json({
                        code: 20010,
                        msg: "Already processed"
                    });
                    return;
                }
            } catch (e) {}

            metadata.times.priorPaymentChecked = Date.now();

            const maxUsableCLTV: BN = parsedBody.expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

            const { current_block_height } = await lncli.getHeight({lnd: this.LND});

            metadata.times.blockheightFetched = Date.now();

            //Probe for a route
            const parsedRequest = await lncli.parsePaymentRequest({
                request: parsedBody.pr
            });
            console.log("[To BTC-LN: REST.payInvoice] Parsed PR: ", JSON.stringify(parsedRequest, null, 4));

            metadata.times.prParsed = Date.now();

            const probeReq: any = {
                destination: parsedPR.payeeNodeKey,
                cltv_delta: parsedPR.tagsObject.min_final_cltv_expiry,
                mtokens: parsedPR.millisatoshis,
                max_fee_mtokens: parsedBody.maxFee.mul(new BN(1000)).toString(10),
                max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10),
                payment: parsedRequest.payment,
                total_mtokens: parsedPR.millisatoshis,
                routes: parsedRequest.routes
            };
            metadata.probeRequest = {...probeReq};

            //if(hints.length>0) req.routes = [hints];
            console.log("[To BTC-LN: REST.payInvoice] Probe for route: ", JSON.stringify(probeReq, null, 4));
            probeReq.lnd = this.LND;

            let is_snowflake: boolean = false;
            if(parsedRequest.routes!=null) {
                for(let route of parsedRequest.routes) {
                    if(SNOWFLAKE_LIST.has(route[0].public_key) || SNOWFLAKE_LIST.has(route[1].public_key)) {
                        is_snowflake = true;
                    }
                }
            }

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);
            const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken) : null;
            const anyContract: any = this.swapContract;
            const signDataPrefetchPromise: Promise<any> = anyContract.preFetchBlockDataForSignatures!=null ? anyContract.preFetchBlockDataForSignatures() : null;

            if(pricePrefetchPromise!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetching swap price!");
            if(signDataPrefetchPromise!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetching signature data!");

            let obj;
            if(!is_snowflake) try {
                obj = await lncli.probeForRoute(probeReq);
            } catch (e) {
                console.error(e);
            }

            metadata.times.probeResult = Date.now();
            metadata.probeResponse = {...obj};

            console.log("[To BTC-LN: REST.payInvoice] Probe result: ", obj);

            if(obj==null || obj.route==null) {
                if(!this.config.allowProbeFailedSwaps) {
                    res.status(400).json({
                        code: 20002,
                        msg: "Cannot route the payment!"
                    });
                    return;
                }

                probeReq.is_ignoring_past_failures = true;

                let routingObj;
                try {
                    routingObj = await lncli.getRouteToDestination(probeReq);
                } catch (e) {
                    console.error(e);
                }

                console.log("[To BTC-LN: REST.payInvoice] Routing result: ", routingObj);

                if(routingObj==null || routingObj.route==null) {
                    res.status(400).json({
                        code: 20002,
                        msg: "Cannot route the payment!"
                    });
                    return;
                }

                metadata.times.routingResult = Date.now();
                metadata.routeResponse = {...routingObj};

                obj = routingObj;
                obj.route.confidence = 0;
            }

            let actualRoutingFee: BN = new BN(obj.route.safe_fee).mul(this.config.routingFeeMultiplier);

            const minRoutingFee: BN = amountBD.mul(this.config.minLnRoutingFeePPM).div(new BN(1000000)).add(this.config.minLnBaseFee);
            if(actualRoutingFee.lt(minRoutingFee)) {
                actualRoutingFee = minRoutingFee;
                if(actualRoutingFee.gt(parsedBody.maxFee)) {
                    obj.route.confidence = 0;
                }
            }

            if(actualRoutingFee.gt(parsedBody.maxFee)) {
                actualRoutingFee = parsedBody.maxFee;
            }

            const swapFee = amountBD.mul(this.config.feePPM).div(new BN(1000000)).add(this.config.baseFee);

            const prefetchedPrice = pricePrefetchPromise!=null ? await pricePrefetchPromise : null;
            if(prefetchedPrice!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched price: ", prefetchedPrice.toString(10));

            const routingFeeInToken = await this.swapPricing.getFromBtcSwapAmount(actualRoutingFee, useToken, true, prefetchedPrice);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, prefetchedPrice);
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken, true, prefetchedPrice);

            const total = amountInToken.add(routingFeeInToken).add(swapFeeInToken);

            metadata.times.priceCalculated = Date.now();

            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                parsedBody.offerer,
                this.swapContract.getAddress(),
                useToken,
                total,
                parsedPR.tagsObject.payment_hash,
                parsedBody.expiryTimestamp,
                new BN(0),
                0,
                true,
                false,
                new BN(0),
                new BN(0)
            );

            metadata.times.swapCreated = Date.now();

            const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;

            if(prefetchedSignData!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched signature data: ", prefetchedSignData);

            const sigData = await (this.swapContract as any).getClaimInitSignature(
                payObject,
                this.nonce,
                this.config.authorizationTimeout,
                prefetchedSignData
            );

            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcLnSwapAbs<T>(parsedBody.pr, swapFee, actualRoutingFee, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(parsedPR.tagsObject.payment_hash, createdSwap);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    maxFee: routingFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    total: total.toString(10),
                    confidence: halfConfidence ? obj.route.confidence/2000000 : obj.route.confidence/1000000,
                    address: this.swapContract.getAddress(),

                    routingFeeSats: actualRoutingFee.toString(10),

                    data: payObject.serialize(),

                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });
        }));

        const getRefundAuthorization = expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          Identifier of the swap
             */
            const parsedBody = verifySchema({...req.body, ...req.query}, {
                paymentHash: (val: string) => val!=null &&
                typeof(val)==="string" &&
                val.length===64 &&
                HEX_REGEX.test(val) ? val: null,
            });

            if (parsedBody==null) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            const data = this.storageManager.data[parsedBody.paymentHash];

            const isSwapFound = data!=null;
            if(isSwapFound) {
                if(data.state===ToBtcLnSwapState.NON_PAYABLE) {
                    const isCommited = await this.swapContract.isCommited(data.data);

                    if(!isCommited) {
                        res.status(400).json({
                            code: 20005,
                            msg: "Not committed"
                        });
                        return;
                    }

                    const refundSigData = await this.swapContract.getRefundSignature(data.data, this.config.authorizationTimeout);

                    res.status(200).json({
                        code: 20000,
                        msg: "Success",
                        data: {
                            address: this.swapContract.getAddress(),
                            prefix: refundSigData.prefix,
                            timeout: refundSigData.timeout,
                            signature: refundSigData.signature
                        }
                    });
                    return;
                }
            }

            const payment = await lncli.getPayment({
                id: parsedBody.paymentHash,
                lnd: this.LND
            }).catch(err => {
                console.error(err);
            });

            if(payment==null) {
                res.status(200).json({
                    code: 20007,
                    msg: "Payment not found"
                });
                return;
            }

            if(payment.is_pending) {
                res.status(200).json({
                    code: 20008,
                    msg: "Payment in-flight"
                });
                return;
            }

            if(payment.is_confirmed) {
                res.status(200).json({
                    code: 20006,
                    msg: "Already paid",
                    data: {
                        secret: payment.payment.secret
                    }
                });
                return;
            }

            if(payment.is_failed) {
                //TODO: This might not be the best idea with EVM chains
                const commitedData = await this.swapContract.getCommitedData(parsedBody.paymentHash);

                if(commitedData==null) {
                    res.status(400).json({
                        code: 20005,
                        msg: "Not committed"
                    });
                    return;
                }

                const refundSigData = await this.swapContract.getRefundSignature(commitedData, this.config.authorizationTimeout);

                res.status(200).json({
                    code: 20000,
                    msg: "Success",
                    data: {
                        address: this.swapContract.getAddress(),
                        prefix: refundSigData.prefix,
                        timeout: refundSigData.timeout,
                        signature: refundSigData.signature
                    }
                });
            }
        });

        restServer.post(this.path+'/getRefundAuthorization', getRefundAuthorization);
        restServer.get(this.path+'/getRefundAuthorization', getRefundAuthorization);

        console.log("[To BTC-LN: REST] Started at path: ", this.path);
    }

    /**
     * Subscribes to chain events
     */
    private subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[To BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    /**
     * Starts watchdog checking lightning network payment attempts, and removing expired swaps
     */
    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastInvoices().catch( e => console.error(e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    async init() {
        await this.storageManager.loadData(ToBtcLnSwapAbs);
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
                minCltv: this.config.minSendCltv.toNumber(),
                minTimestampCltv: this.config.minTsSendCltv.toNumber()
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }

}
