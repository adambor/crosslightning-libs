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
    SwapCommitStatus,
    SwapContract,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {randomBytes} from "crypto";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import * as express from "express";

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
    minLnBaseFee?: BN,

    exactInExpiry?: number
};

const SNOWFLAKE_LIST: Set<string> = new Set([
    "038f8f113c580048d847d6949371726653e02b928196bad310e3eda39ff61723f6"
]);

type LNRoutes = {
    public_key: string,
    fee_rate?: number,
    cltv_delta?: number,
    channel?: string,
    base_fee_mtokens?: string
}[][];

function routesMatch(routesA: LNRoutes, routesB: LNRoutes) {
    if(routesA===routesB) return true;
    if(routesA==null || routesB==null) {
        return false;
    }
    if(routesA.length!==routesB.length) return false;
    for(let i=0;i<routesA.length;i++) {
        if(routesA[i]===routesB[i]) continue;
        if(routesA[i]==null || routesB[i]==null) {
            return false;
        }
        if(routesA[i].length!==routesB[i].length) return false;
        for(let e=0;e<routesA[i].length;e++) {
            if(routesA[i][e]===routesB[i][e]) continue;
            if(routesA[i][e]==null || routesB[i][e]==null) {
                return false;
            }
            if(
                routesA[i][e].public_key!==routesB[i][e].public_key ||
                routesA[i][e].base_fee_mtokens!==routesB[i][e].base_fee_mtokens ||
                routesA[i][e].channel!==routesB[i][e].channel ||
                routesA[i][e].cltv_delta!==routesB[i][e].cltv_delta ||
                routesA[i][e].fee_rate!==routesB[i][e].fee_rate
            ) {
                return false;
            }
        }
    }

    return true;
}

type ExactInAuthorization = {
    reqId: string,
    expiry: number,

    amount: BN,
    destination: string,
    cltvDelta: number,
    routes: LNRoutes,

    maxFee: BN,
    swapFee: BN,
    total: BN,
    confidence: number,
    routingFeeSats: BN,
    swapFeeSats: BN,

    token: TokenAddress,
    swapExpiry: BN,
    offerer: string,

    preFetchSignData: any,
    metadata: {
        request: any,
        probeRequest?: any,
        probeResponse?: any,
        routeResponse?: any,
        times: {[key: string]: number}
    }
}

export type ToBtcLnRequestType = {
    pr: string,
    maxFee: BN,
    expiryTimestamp: BN,
    token: string,
    offerer: string,
    exactIn?: boolean,
    amount?: BN
};

/**
 * Swap handler handling to BTCLN swaps using submarine swaps
 */
export class ToBtcLnAbs<T extends SwapData> extends SwapHandler<ToBtcLnSwapAbs<T>, T> {

    activeSubscriptions: Set<string> = new Set<string>();

    readonly type = SwapHandlerType.TO_BTCLN;

    readonly config: ToBtcLnConfig & {minTsSendCltv: BN};

    readonly exactInAuths: {
        [reqId: string]: ExactInAuthorization
    } = {};

    constructor(
        storageDirectory: IIntermediaryStorage<ToBtcLnSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: ToBtcLnConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, allowedTokens, lnd, swapPricing);
        const anyConfig = config as any;
        anyConfig.minTsSendCltv = config.gracePeriod.add(config.bitcoinBlocktime.mul(config.minSendCltv).mul(config.safetyFactor));
        this.config = anyConfig;
        this.config.minLnRoutingFeePPM = this.config.minLnRoutingFeePPM || new BN(1000);
        this.config.minLnBaseFee = this.config.minLnBaseFee || new BN(5);
        this.config.exactInExpiry = this.config.exactInExpiry || 10*1000;
    }

    /**
     * Checks past swaps, deletes ones that are already expired, and tries to process ones that are committed.
     */
    private async checkPastInvoices() {

        for(let key in this.exactInAuths) {
            const obj = this.exactInAuths[key];
            if(obj.expiry<Date.now()) {
                delete this.exactInAuths[key];
            }
        }

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    ToBtcLnSwapState.SAVED,
                    ToBtcLnSwapState.COMMITED,
                    ToBtcLnSwapState.PAID,
                    ToBtcLnSwapState.NON_PAYABLE
                ]
            }
        ]);

        for(let invoiceData of queriedData) {
            const decodedPR = bolt11.decode(invoiceData.pr);

            const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew));

            if (invoiceData.state === ToBtcLnSwapState.SAVED) {
                //Current timestamp plus maximum allowed on-chain time skew

                const isSignatureExpired = invoiceData.signatureExpiry!=null && invoiceData.signatureExpiry.lt(timestamp);
                if(isSignatureExpired) {
                    await invoiceData.setState(ToBtcLnSwapState.CANCELED);
                    await this.removeSwapData(invoiceData.getHash(), invoiceData.data.getSequence());
                    continue;
                }

                //Yet unpaid
                const isInvoiceExpired = decodedPR.timeExpireDate < Date.now() / 1000;
                if (isInvoiceExpired) {
                    //Expired
                    await invoiceData.setState(ToBtcLnSwapState.CANCELED);
                    await this.removeSwapData(invoiceData.getHash(), invoiceData.data.getSequence());
                    continue;
                }
            }

            if (invoiceData.state === ToBtcLnSwapState.COMMITED || invoiceData.state === ToBtcLnSwapState.PAID) {
                await this.processInitialized(invoiceData);
            }

            if (invoiceData.state === ToBtcLnSwapState.NON_PAYABLE) {
                if(invoiceData.data.getExpiry().lt(timestamp)) {
                    await this.removeSwapData(invoiceData.getHash(), invoiceData.data.getSequence());
                }
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
            await this.removeSwapData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence());
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
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence(), invoiceData);

            //Check if escrow state exists
            const isCommited = await this.swapContract.isCommited(invoiceData.data);

            if(!isCommited) {
                const status = await this.swapContract.getCommitStatus(invoiceData.data);
                if(status===SwapCommitStatus.PAID) {
                    await invoiceData.setState(ToBtcLnSwapState.CLAIMED);
                    await this.removeSwapData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence());
                } else if(status===SwapCommitStatus.EXPIRED) {
                    await invoiceData.setState(ToBtcLnSwapState.REFUNDED);
                    await this.removeSwapData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence());
                }
                console.error("[To BTC-LN: BTCLN.PaymentResult] Tried to claim but escrow doesn't exist anymore, commit status="+status+" : ", decodedPR.tagsObject.payment_hash);
                return;
            }

            //Set flag that we are sending the transaction already, so we don't end up with race condition
            const unlock: () => boolean = invoiceData.lock(this.swapContract.claimWithSecretTimeout);
            if(unlock==null) return;

            const success = await this.swapContract.claimWithSecret(invoiceData.data, lnPaymentStatus.payment.secret, false, false, true);

            if(invoiceData.metadata!=null) invoiceData.metadata.times.txClaimed = Date.now();

            // if(success) {
            //     if(invoiceData.state!==ToBtcLnSwapState.CLAIMED) {
            //         await invoiceData.setState(ToBtcLnSwapState.CLAIMED);
            //         await this.removeSwapData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence());
            //     }
            // }
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
    private async processInitialized(invoiceData: ToBtcLnSwapAbs<T>) {

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
            await invoiceData.setState(ToBtcLnSwapState.NON_PAYABLE);
            // await PluginManager.swapStateChange(invoiceData);
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence(), invoiceData);
        };

        const paymentExists = lnPaymentStatus!=null;
        if(!paymentExists) {
            if (!invoiceData.data.isToken(invoiceData.data.getToken())) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid token used");
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] Struct: ", invoiceData.data);

            //const tokenAmount: BN = data.getAmount();
            const expiryTimestamp: BN = invoiceData.data.getExpiry();
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

            await invoiceData.setState(ToBtcLnSwapState.COMMITED);
            // await PluginManager.swapStateChange(invoiceData);
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData.data.getSequence(), invoiceData);

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

                if(event.swapType!==ChainSwapType.HTLC) {
                    //Only process ln requests
                    continue;
                }

                const paymentHash = event.paymentHash;

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    // console.error("[To BTC-LN: Solana.Initialize] No invoice submitted: ", paymentHash);
                    continue;
                }

                if(savedInvoice.metadata!=null) savedInvoice.metadata.times.txReceived = Date.now();

                console.log("[To BTC-LN: Solana.Initialize] SOL request submitted: ", paymentHash);

                //Only process swaps in SAVED state
                if(savedInvoice.state!==ToBtcLnSwapState.SAVED) continue;

                await this.processInitialized(savedInvoice);

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(event.paymentHash, "hex");

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.ClaimEvent] No invoice submitted: ", paymentHash);
                    continue;
                }

                console.log("[To BTC-LN: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await savedInvoice.setState(ToBtcLnSwapState.CLAIMED);
                await this.removeSwapData(paymentHash, event.sequence);
                continue;
            }
            if(event instanceof RefundEvent) {
                const paymentHash = event.paymentHash;

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.RefundEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC-LN: Solana.RefundEvent] Transaction refunded! Event: ", event);

                await savedInvoice.setState(ToBtcLnSwapState.REFUNDED);
                await this.removeSwapData(paymentHash, event.sequence);

                continue;
            }
        }

        return true;

    }

    startRestServer(restServer: Express) {

        restServer.use(this.path+"/payInvoiceExactIn", serverParamDecoder(10*1000));
        restServer.post(this.path+"/payInvoiceExactIn", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            /**
             * pr: string                   bolt11 lightning invoice
             * reqId: string                Identifier of the swap
             * feeRate: string              Fee rate to use for the init tx
             */
            const parsedBody = await req.paramReader.getParams({
                pr: FieldTypeEnum.String,
                reqId: FieldTypeEnum.String,
                feeRate: FieldTypeEnum.String
            });

            const responseStream = res.responseStream;

            if (parsedBody==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20100,
                    msg: "Invalid request body"
                });
                return;
            }

            const parsedAuth = this.exactInAuths[parsedBody.reqId];

            if (parsedAuth==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20070,
                    msg: "Invalid reqId"
                });
                return;
            }

            delete this.exactInAuths[parsedBody.reqId];

            if(parsedAuth.expiry<Date.now()) {
                await responseStream.writeParamsAndEnd({
                    code: 20200,
                    msg: "Authorization already expired!"
                });
                return;
            }

            let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

            try {
                parsedPR = bolt11.decode(parsedBody.pr);
            } catch (e) {
                console.error(e);
                await responseStream.writeParamsAndEnd({
                    code: 20021,
                    msg: "Invalid request body (pr - cannot be parsed)"
                });
                return;
            }

            let halfConfidence = false;
            if(parsedPR.timeExpireDate < ((Date.now()/1000)+(this.config.authorizationTimeout+(2*60)))) {
                if(!this.config.allowShortExpiry) {
                    await responseStream.writeParamsAndEnd({
                        code: 20020,
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                } else if(parsedPR.timeExpireDate < Date.now()/1000) {
                    await responseStream.writeParamsAndEnd({
                        code: 20020,
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                }
                halfConfidence = true;
            }

            const parsedRequest = await lncli.parsePaymentRequest({
                request: parsedBody.pr
            });
            console.log("[To BTC-LN: REST.payInvoice] Parsed PR: ", JSON.stringify(parsedRequest, null, 4));

            if(
                parsedPR.payeeNodeKey!==parsedAuth.destination ||
                parsedPR.tagsObject.min_final_cltv_expiry!==parsedAuth.cltvDelta ||
                !new BN(parsedPR.millisatoshis).div(new BN(1000)).eq(parsedAuth.amount)
            ) {
                await responseStream.writeParamsAndEnd({
                    code: 20102,
                    msg: "Provided PR doesn't match initial!"
                });
                return;
            }

            if(!routesMatch(parsedRequest.routes, parsedAuth.routes)) {
                await responseStream.writeParamsAndEnd({
                    code: 20102,
                    msg: "Provided PR doesn't match initial (routes)!"
                });
                return;
            }

            const metadata = parsedAuth.metadata;

            const sequence = new BN(randomBytes(8));

            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                parsedAuth.offerer,
                this.swapContract.getAddress(),
                this.swapContract.toTokenAddress(parsedAuth.token),
                parsedAuth.total,
                parsedPR.tagsObject.payment_hash,
                sequence,
                parsedAuth.swapExpiry,
                new BN(0),
                0,
                true,
                false,
                new BN(0),
                new BN(0)
            );

            metadata.times.swapCreated = Date.now();

            const prefetchedSignData = parsedAuth.preFetchSignData;

            if(prefetchedSignData!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched signature data: ", prefetchedSignData);

            const feeRate = parsedBody.feeRate;
            const sigData = await this.swapContract.getClaimInitSignature(
                payObject,
                this.config.authorizationTimeout,
                prefetchedSignData,
                feeRate
            );

            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcLnSwapAbs<T>(parsedBody.pr, parsedAuth.swapFee, parsedAuth.routingFeeSats, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(parsedPR.tagsObject.payment_hash, sequence, createdSwap);

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    maxFee: parsedAuth.maxFee.toString(10),
                    swapFee: parsedAuth.swapFee.toString(10),
                    total: parsedAuth.total.toString(10),
                    confidence: halfConfidence ? parsedAuth.confidence/2000000 : parsedAuth.confidence/1000000,
                    address: this.swapContract.getAddress(),

                    routingFeeSats: parsedAuth.routingFeeSats.toString(10),

                    data: payObject.serialize(),

                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        }));

        restServer.use(this.path+"/payInvoice", serverParamDecoder(10*1000));
        restServer.post(this.path+"/payInvoice", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                probeRequest?: any,
                probeResponse?: any,
                routeResponse?: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             *Sent initially:
             * pr: string                   bolt11 lightning invoice
             * maxFee: string               maximum routing fee
             * expiryTimestamp: string      expiry timestamp of the to be created HTLC, determines how many LN paths can be considered
             * token: string                Desired token to use
             * offerer: string              Address of the caller
             * exactIn: boolean             Whether to do an exact in swap instead of exact out
             * amount: string               Input amount for exactIn swaps
             *
             *Sent later:
             * feeRate: string              Fee rate to use for the init signature
             */
            const parsedBody: ToBtcLnRequestType = await req.paramReader.getParams({
                pr: FieldTypeEnum.String,
                maxFee: FieldTypeEnum.BN,
                expiryTimestamp: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                offerer: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.swapContract.isValidAddress(val) ? val : null,
                exactIn: FieldTypeEnum.BooleanOptional,
                amount: FieldTypeEnum.BNOptional
            });

            metadata.request = parsedBody;

            const responseStream = res.responseStream;

            console.log("Parsed body: ", parsedBody);

            if (parsedBody==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20100,
                    msg: "Invalid request body"
                });
                return;
            }

            let requestAmount: BN = parsedBody.amount;
            if(parsedBody.exactIn) {
                if(requestAmount==null) {
                    await responseStream.writeParamsAndEnd({
                        code: 20040,
                        msg: "Invalid request body (amount not specified)!"
                    });
                    return;
                }
            }

            if(parsedBody.maxFee.isNeg() || parsedBody.maxFee.isZero()) {
                await responseStream.writeParamsAndEnd({
                    code: 20030,
                    msg: "Invalid request body (maxFee too low)!"
                });
                return;
            }

            let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

            try {
                parsedPR = bolt11.decode(parsedBody.pr);
            } catch (e) {
                console.error(e);
                await responseStream.writeParamsAndEnd({
                    code: 20021,
                    msg: "Invalid request body (pr - cannot be parsed)"
                });
                return;
            }

            let halfConfidence = false;
            if(parsedPR.timeExpireDate < ((Date.now()/1000)+(this.config.authorizationTimeout+(2*60)))) {
                if(!this.config.allowShortExpiry) {
                    await responseStream.writeParamsAndEnd({
                        code: 20020,
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                } else if(parsedPR.timeExpireDate < Date.now()/1000) {
                    await responseStream.writeParamsAndEnd({
                        code: 20020,
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                }
                halfConfidence = true;
            }

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));

            const expiresTooSoon = parsedBody.expiryTimestamp.sub(currentTimestamp).lt(this.config.minTsSendCltv);
            if(expiresTooSoon) {
                await responseStream.writeParamsAndEnd({
                    code: 20001,
                    msg: "Expiry time too low!"
                });
                return;
            }

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            const pluginResult = await PluginManager.onSwapRequestToBtcLn(req, parsedBody, metadata);

            if(pluginResult.throw) {
                await responseStream.writeParamsAndEnd({
                    code: 29999,
                    msg: pluginResult.throw
                });
                return;
            }

            let baseFee = pluginResult.baseFee || this.config.baseFee;
            let feePPM = pluginResult.feePPM || this.config.feePPM;

            const abortController = new AbortController();
            const responseStreamAbortController = responseStream.getAbortSignal();
            responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));

            const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken).catch(e => {
                console.error("To BTC-LN: REST.pricePrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;
            let signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
                console.error("To BTC-LN: REST.signDataPrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;

            if(pricePrefetchPromise!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetching swap price!");
            if(signDataPrefetchPromise!=null) {
                signDataPrefetchPromise = signDataPrefetchPromise.then(val => val==null || abortController.signal.aborted ? null : responseStream.writeParams({
                    signDataPrefetch: val
                }).then(() => val)).catch(e => {
                    console.error("[To BTC-LN: REST.payInvoice] Send signDataPreFetch error: ", e);
                    abortController.abort(e);
                    return null;
                });
                console.log("[To BTC-LN: REST.payInvoice] Pre-fetching signature data!");
            }

            let amountBD;
            let tooLow = false;

            if(parsedBody.exactIn) {
                amountBD = await this.swapPricing.getToBtcSwapAmount(requestAmount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                //Decrease by base fee
                amountBD = amountBD.sub(baseFee);

                //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
                if(amountBD.lt(this.config.min)) {
                    amountBD = this.config.min;
                    tooLow = true;
                }

                parsedBody.maxFee = await this.swapPricing.getToBtcSwapAmount(parsedBody.maxFee, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                abortController.signal.throwIfAborted();
            } else {
                amountBD = new BN(parsedPR.satoshis);

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

            metadata.times.requestChecked = Date.now();

            //Check if prior payment has been made
            try {
                const payment = await lncli.getPayment({
                    lnd: this.LND,
                    id: parsedPR.tagsObject.payment_hash
                });

                if(payment!=null) {
                    await responseStream.writeParamsAndEnd({
                        code: 20010,
                        msg: "Already processed"
                    });
                    return;
                }
            } catch (e) {}

            abortController.signal.throwIfAborted();

            metadata.times.priorPaymentChecked = Date.now();

            // const existingSwap = await this.storageManager.getData(parsedPR.tagsObject.payment_hash);
            // if(existingSwap!=null && existingSwap.state!=ToBtcLnSwapState.SAVED) {
            //     await responseStream.writeParamsAndEnd({
            //         code: 20010,
            //         msg: "Already processed"
            //     });
            //     return;
            // }

            const amountBDMtokens = amountBD.mul(new BN(1000));
            const channelBalances = await lncli.getChannelBalance({lnd: this.LND});
            const localBalance = new BN(channelBalances.channel_balance_mtokens);
            if(amountBDMtokens.gt(localBalance)) {
                await responseStream.writeParamsAndEnd({
                    code: 20002,
                    msg: "Not enough liquidity"
                });
                return;
            }
            metadata.times.liquidityChecked = Date.now();

            const maxUsableCLTV: BN = parsedBody.expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

            const { current_block_height } = await lncli.getHeight({lnd: this.LND});

            abortController.signal.throwIfAborted();

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
                mtokens: amountBDMtokens.toString(10),
                max_fee_mtokens: parsedBody.maxFee.mul(new BN(1000)).toString(10),
                max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10),
                payment: parsedRequest.payment,
                total_mtokens: amountBDMtokens.toString(10),
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

            let obj;
            if(!is_snowflake) try {
                obj = await lncli.probeForRoute(probeReq);
            } catch (e) {
                console.error(e);
            }

            abortController.signal.throwIfAborted();

            metadata.times.probeResult = Date.now();
            metadata.probeResponse = {...obj};

            console.log("[To BTC-LN: REST.payInvoice] Probe result: ", obj);

            if(obj==null || obj.route==null) {
                if(!this.config.allowProbeFailedSwaps) {
                    await responseStream.writeParamsAndEnd({
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

                abortController.signal.throwIfAborted();

                console.log("[To BTC-LN: REST.payInvoice] Routing result: ", routingObj);

                if(routingObj==null || routingObj.route==null) {
                    await responseStream.writeParamsAndEnd({
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

            if(parsedBody.exactIn) {
                //Decrease by network fee
                amountBD = amountBD.sub(actualRoutingFee);

                //Decrease by percentage fee
                amountBD = amountBD.mul(new BN(1000000)).div(feePPM.add(new BN(1000000)));

                if(tooLow || amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                    //Compute min/max
                    let adjustedMin = this.config.min.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(baseFee).add(actualRoutingFee);
                    adjustedMax = adjustedMax.add(baseFee).add(actualRoutingFee);
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
                    let adjustedMin = this.config.min.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(baseFee).add(actualRoutingFee);
                    adjustedMax = adjustedMax.add(baseFee).add(actualRoutingFee);
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
            }

            const swapFee = amountBD.mul(feePPM).div(new BN(1000000)).add(baseFee);

            const prefetchedPrice = pricePrefetchPromise!=null ? await pricePrefetchPromise : null;
            if(prefetchedPrice!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched price: ", prefetchedPrice.toString(10));

            abortController.signal.throwIfAborted();

            const routingFeeInToken = await this.swapPricing.getFromBtcSwapAmount(actualRoutingFee, useToken, true, prefetchedPrice);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, prefetchedPrice);

            abortController.signal.throwIfAborted();

            let amountInToken: BN;
            let total: BN;
            if(parsedBody.exactIn) {
                amountInToken = requestAmount.sub(swapFeeInToken).sub(routingFeeInToken);
                total = requestAmount;

                const reqId = randomBytes(32).toString("hex");
                this.exactInAuths[reqId] = {
                    reqId,
                    expiry: Date.now()+this.config.exactInExpiry,

                    amount: amountBD,
                    destination: parsedPR.payeeNodeKey,
                    cltvDelta: parsedPR.tagsObject.min_final_cltv_expiry,
                    routes: parsedRequest.routes,

                    maxFee: routingFeeInToken,
                    swapFee: swapFeeInToken,
                    total: total,
                    confidence: obj.route.confidence,
                    routingFeeSats: actualRoutingFee,
                    swapFeeSats: swapFee,

                    token: useToken,
                    swapExpiry: parsedBody.expiryTimestamp,
                    offerer: parsedBody.offerer,

                    preFetchSignData: signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null,
                    metadata
                };

                metadata.times.priceCalculated = Date.now();

                await responseStream.writeParamsAndEnd({
                    code: 20000,
                    msg: "Success",
                    data: {
                        amount: amountBD.toString(10),
                        reqId
                    }
                });
                return;
            } else {
                amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken, true, prefetchedPrice);
                total = amountInToken.add(routingFeeInToken).add(swapFeeInToken);

                abortController.signal.throwIfAborted();
            }

            metadata.times.priceCalculated = Date.now();

            const sequence = new BN(randomBytes(8));

            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                parsedBody.offerer,
                this.swapContract.getAddress(),
                useToken,
                total,
                parsedPR.tagsObject.payment_hash,
                sequence,
                parsedBody.expiryTimestamp,
                new BN(0),
                0,
                true,
                false,
                new BN(0),
                new BN(0)
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapCreated = Date.now();

            const prefetchedSignData = signDataPrefetchPromise!=null ? await signDataPrefetchPromise : null;
            if(prefetchedSignData!=null) console.log("[To BTC-LN: REST.payInvoice] Pre-fetched signature data: ", prefetchedSignData);

            abortController.signal.throwIfAborted();

            const feeRateObj = await req.paramReader.getParams({
                feeRate: FieldTypeEnum.String
            }).catch(e => null);

            abortController.signal.throwIfAborted();

            const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;
            const sigData = await this.swapContract.getClaimInitSignature(
                payObject,
                this.config.authorizationTimeout,
                prefetchedSignData,
                feeRate
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcLnSwapAbs<T>(parsedBody.pr, swapFee, actualRoutingFee, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(parsedPR.tagsObject.payment_hash, sequence, createdSwap);

            await responseStream.writeParamsAndEnd({
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

                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });
        }));

        const getRefundAuthorization = expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          Identifier of the swap
             * sequence: BN                 Sequence identifier of the swap
             */
            const parsedBody = verifySchema({...req.body, ...req.query}, {
                paymentHash: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    val.length===64 &&
                    HEX_REGEX.test(val) ? val: null,
                sequence: FieldTypeEnum.BN
            });

            if (parsedBody==null) {
                res.status(400).json({
                    code: 20100,
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            if(parsedBody.sequence.isNeg() || parsedBody.sequence.gte(new BN(2).pow(new BN(64)))) {
                res.status(400).json({
                    code: 20060,
                    msg: "Invalid sequence"
                });
                return;
            }

            const data = await this.storageManager.getData(parsedBody.paymentHash, parsedBody.sequence);

            const isSwapFound = data!=null;
            if(isSwapFound) {
                const isExpired = data.data.getExpiry().lt(new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew)));
                if(isExpired) {
                    res.status(200).json({
                        code: 20010,
                        msg: "Payment expired"
                    });
                    return;
                }

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

                    //Double check the state after promise result
                    if (data.state !== ToBtcLnSwapState.NON_PAYABLE) {
                        res.status(400).json({
                            code: 20005,
                            msg: "Not committed"
                        });
                        return;
                    }

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
