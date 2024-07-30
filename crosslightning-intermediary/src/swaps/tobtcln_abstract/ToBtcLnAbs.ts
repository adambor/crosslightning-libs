import * as BN from "bn.js";
import {Express} from "express";
import * as bolt11 from "bolt11";
import * as lncli from "ln-service";
import {ToBtcLnSwapAbs, ToBtcLnSwapState} from "./ToBtcLnSwapAbs";
import {SwapHandler, SwapHandlerType, ToBtcBaseConfig} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapCommitStatus,
    SwapContract,
    SwapData,
    SwapEvent,
    TokenAddress
} from "crosslightning-base";
import {AuthenticatedLnd, pay} from "lightning";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {randomBytes} from "crypto";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";

export type ToBtcLnConfig = ToBtcBaseConfig & {
    routingFeeMultiplier: BN,

    minSendCltv: BN,

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

    readonly pdaExistsForToken: {
        [token: string]: boolean
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

            if(decodedPR.millisatoshis==null) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid invoice with no amount");
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
                savedInvoice.txIds.init = (event as any).meta?.txId;

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
                savedInvoice.txIds.claim = (event as any).meta?.txId;

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
                savedInvoice.txIds.refund = (event as any).meta?.txId;

                console.log("[To BTC-LN: Solana.RefundEvent] Transaction refunded! Event: ", event);

                await savedInvoice.setState(ToBtcLnSwapState.REFUNDED);
                await this.removeSwapData(paymentHash, event.sequence);

                continue;
            }
        }

        return true;

    }

    checkAmount(amount: BN, exactIn: boolean): void {
        if(exactIn) {
            if(amount==null) {
                throw {
                    code: 20040,
                    msg: "Invalid request body (amount not specified)!"
                };
            }
        }
    }

    checkMaxFee(maxFee: BN): void {
        if(maxFee.isNeg() || maxFee.isZero()) {
            throw {
                code: 20030,
                msg: "Invalid request body (maxFee too low)!"
            };
        }
    }

    checkPaymentRequest(pr: string): {
        parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject },
        halfConfidence: boolean
    } {
        let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

        try {
            parsedPR = bolt11.decode(pr);
        } catch (e) {
            console.error(e);
            throw {
                code: 20021,
                msg: "Invalid request body (pr - cannot be parsed)"
            };
        }

        let halfConfidence = false;
        if(parsedPR.timeExpireDate < ((Date.now()/1000)+(this.config.authorizationTimeout+(2*60)))) {
            if(!this.config.allowShortExpiry) {
                throw {
                    code: 20020,
                    msg: "Invalid request body (pr - expired)"
                };
            } else if(parsedPR.timeExpireDate < Date.now()/1000) {
                throw {
                    code: 20020,
                    msg: "Invalid request body (pr - expired)"
                };
            }
            halfConfidence = true;
        }

        return {parsedPR, halfConfidence};
    }

    checkExpiry(expiryTimestamp: BN, currentTimestamp: BN): void {
        const expiresTooSoon = expiryTimestamp.sub(currentTimestamp).lt(this.config.minTsSendCltv);
        if(expiresTooSoon) {
            throw {
                code: 20001,
                msg: "Expiry time too low!"
            };
        }
    }

    async checkPlugins(req: Request & {paramReader: IParamReader}, parsedBody: ToBtcLnRequestType, metadata: any): Promise<{baseFee: BN, feePPM: BN}> {
        const pluginResult = await PluginManager.onSwapRequestToBtcLn(req, parsedBody, metadata);

        if(pluginResult.throw) {
            throw {
                code: 29999,
                msg: pluginResult.throw
            };
        }

        return {
            baseFee: pluginResult.baseFee || this.config.baseFee,
            feePPM: pluginResult.feePPM || this.config.feePPM
        };
    }

    async checkPriorPayment(paymentHash: string, abortSignal: AbortSignal): Promise<void> {
        try {
            const payment = await lncli.getPayment({
                lnd: this.LND,
                id: paymentHash
            });

            if(payment!=null) {
                throw {
                    code: 20010,
                    msg: "Already processed"
                };
            }
        } catch (e) {}
        abortSignal.throwIfAborted();
    }

    async checkLiquidity(amount: BN, abortSignal: AbortSignal): Promise<void> {
        const amountBDMtokens = amount.mul(new BN(1000));
        const channelBalances = await lncli.getChannelBalance({lnd: this.LND});
        const localBalance = new BN(channelBalances.channel_balance_mtokens);
        if(amountBDMtokens.gt(localBalance)) {
            throw {
                code: 20002,
                msg: "Not enough liquidity"
            };
        }
        abortSignal.throwIfAborted();
    }

    async checkNetworkFee(amountBD: BN, maxFee: BN, expiryTimestamp: BN, currentTimestamp: BN, pr: string, metadata: any, abortSignal: AbortSignal): Promise<{
        confidence: number,
        networkFee: BN,
        routes: LNRoutes
    }> {
        const maxUsableCLTV: BN = expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

        const { current_block_height } = await lncli.getHeight({lnd: this.LND});

        abortSignal.throwIfAborted();

        metadata.times.blockheightFetched = Date.now();

        //Probe for a route
        const parsedRequest = await lncli.parsePaymentRequest({
            request: pr
        });
        console.log("[To BTC-LN: REST.payInvoice] Parsed PR: ", JSON.stringify(parsedRequest, null, 4));

        metadata.times.prParsed = Date.now();

        const probeReq: any = {
            destination: parsedRequest.destination,
            cltv_delta: parsedRequest.cltv_delta,
            mtokens: amountBD.mul(new BN(1000)).toString(10),
            max_fee_mtokens: maxFee.mul(new BN(1000)).toString(10),
            max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10),
            payment: parsedRequest.payment,
            total_mtokens: amountBD.mul(new BN(1000)).toString(10),
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

        abortSignal.throwIfAborted();

        metadata.times.probeResult = Date.now();
        metadata.probeResponse = {...obj};

        console.log("[To BTC-LN: REST.payInvoice] Probe result: ", obj);

        if(obj==null || obj.route==null) {
            if(!this.config.allowProbeFailedSwaps) {
                throw {
                    code: 20002,
                    msg: "Cannot route the payment!"
                };
            }

            probeReq.is_ignoring_past_failures = true;

            let routingObj;
            try {
                routingObj = await lncli.getRouteToDestination(probeReq);
            } catch (e) {
                console.error(e);
            }

            abortSignal.throwIfAborted();

            console.log("[To BTC-LN: REST.payInvoice] Routing result: ", routingObj);

            if(routingObj==null || routingObj.route==null) {
                throw {
                    code: 20002,
                    msg: "Cannot route the payment!"
                };
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
            if(actualRoutingFee.gt(maxFee)) {
                obj.route.confidence = 0;
            }
        }

        if(actualRoutingFee.gt(maxFee)) {
            actualRoutingFee = maxFee;
        }

        return {
            networkFee: actualRoutingFee,
            confidence: obj.route.confidence,
            routes: parsedRequest.routes
        };
    }

    checkExactInAuthorization(reqId: string): ExactInAuthorization {
        const parsedAuth = this.exactInAuths[reqId];
        if (parsedAuth==null) {
            throw {
                code: 20070,
                msg: "Invalid reqId"
            };
        }
        delete this.exactInAuths[reqId];
        if(parsedAuth.expiry<Date.now()) {
            throw {
                code: 20200,
                msg: "Authorization already expired!"
            };
        }
        return parsedAuth;
    }

    async checkPaymentRequestMatchesInitial(pr: string, parsedAuth: ExactInAuthorization): Promise<void> {
        const parsedRequest = await lncli.parsePaymentRequest({
            request: pr
        });
        console.log("[To BTC-LN: REST.payInvoice] Parsed PR: ", JSON.stringify(parsedRequest, null, 4));

        if(
            parsedRequest.destination!==parsedAuth.destination ||
            parsedRequest.cltv_delta!==parsedAuth.cltvDelta ||
            !new BN(parsedRequest.mtokens).eq(parsedAuth.amount.mul(new BN(1000)))
        ) {
            throw {
                code: 20102,
                msg: "Provided PR doesn't match initial!"
            };
        }

        if(!routesMatch(parsedRequest.routes, parsedAuth.routes)) {
            throw {
                code: 20102,
                msg: "Provided PR doesn't match initial (routes)!"
            };
        }
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

            const abortSignal = responseStream.getAbortSignal();

            if (parsedBody==null) {
                throw {
                    code: 20100,
                    msg: "Invalid request body"
                };
            }

            const parsedAuth = this.checkExactInAuthorization(parsedBody.reqId);
            const {parsedPR, halfConfidence} = this.checkPaymentRequest(parsedBody.pr);
            await this.checkPaymentRequestMatchesInitial(parsedBody.pr, parsedAuth);

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
            const sigData = await this.getToBtcSignatureData(payObject, req, abortSignal, prefetchedSignData);
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
                throw {
                    code: 20100,
                    msg: "Invalid request body"
                };
            }

            const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            this.checkAmount(parsedBody.amount, parsedBody.exactIn);
            this.checkMaxFee(parsedBody.maxFee);
            const {parsedPR, halfConfidence} = this.checkPaymentRequest(parsedBody.pr);
            this.checkExpiry(parsedBody.expiryTimestamp, currentTimestamp);
            await this.checkVaultInitialized(parsedBody.token);
            const {baseFee, feePPM} = await this.checkPlugins(req, parsedBody, metadata);

            const abortController = this.getAbortController(responseStream);

            const {pricePrefetchPromise, signDataPrefetchPromise} = this.getToBtcPrefetches(useToken, responseStream, abortController);

            const amount: BN = parsedBody.exactIn ? parsedBody.amount : new BN(parsedPR.millisatoshis).add(new BN(999)).div(new BN(1000));
            const {
                amountBD,
                networkFeeData,
                totalInToken,
                swapFee,
                swapFeeInToken,
                networkFeeInToken
            } = await this.checkToBtcAmount(parsedBody.exactIn, amount, useToken, {baseFee, feePPM}, async (amountBD: BN) => {
                metadata.times.requestChecked = Date.now();

                //Check if prior payment has been made
                await this.checkPriorPayment(parsedPR.tagsObject.payment_hash, abortController.signal);
                metadata.times.priorPaymentChecked = Date.now();

                await this.checkLiquidity(amountBD, abortController.signal);
                metadata.times.liquidityChecked = Date.now();

                if(parsedBody.exactIn) parsedBody.maxFee = await this.swapPricing.getToBtcSwapAmount(parsedBody.maxFee, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                return await this.checkNetworkFee(amountBD, parsedBody.maxFee, parsedBody.expiryTimestamp, currentTimestamp, parsedBody.pr, metadata, abortController.signal);
            }, abortController.signal, pricePrefetchPromise);

            metadata.times.priceCalculated = Date.now();

            if(parsedBody.exactIn) {
                const reqId = randomBytes(32).toString("hex");
                this.exactInAuths[reqId] = {
                    reqId,
                    expiry: Date.now() + this.config.exactInExpiry,

                    amount: amountBD,
                    destination: parsedPR.payeeNodeKey,
                    cltvDelta: parsedPR.tagsObject.min_final_cltv_expiry,
                    routes: networkFeeData.routes,

                    maxFee: networkFeeInToken,
                    swapFee: swapFeeInToken,
                    total: totalInToken,
                    confidence: networkFeeData.confidence,
                    routingFeeSats: networkFeeData.networkFee,
                    swapFeeSats: swapFee,

                    token: useToken,
                    swapExpiry: parsedBody.expiryTimestamp,
                    offerer: parsedBody.offerer,

                    preFetchSignData: signDataPrefetchPromise != null ? await signDataPrefetchPromise : null,
                    metadata
                };

                await responseStream.writeParamsAndEnd({
                    code: 20000,
                    msg: "Success",
                    data: {
                        amount: amountBD.toString(10),
                        reqId
                    }
                });
                return;
            }

            const sequence = new BN(randomBytes(8));

            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                parsedBody.offerer,
                this.swapContract.getAddress(),
                useToken,
                totalInToken,
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

            const sigData = await this.getToBtcSignatureData(payObject, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcLnSwapAbs<T>(parsedBody.pr, swapFee, networkFeeData.networkFee, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(parsedPR.tagsObject.payment_hash, sequence, createdSwap);

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    maxFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    total: totalInToken.toString(10),
                    confidence: halfConfidence ? networkFeeData.confidence/2000000 : networkFeeData.confidence/1000000,
                    address: this.swapContract.getAddress(),

                    routingFeeSats: networkFeeData.networkFee.toString(10),

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
                    // const isCommited = await this.swapContract.isCommited(data.data);
                    //
                    // if(!isCommited) {
                    //     res.status(400).json({
                    //         code: 20005,
                    //         msg: "Not committed"
                    //     });
                    //     return;
                    // }

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
