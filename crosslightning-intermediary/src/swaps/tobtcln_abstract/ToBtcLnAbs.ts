import * as BN from "bn.js";
import {Express} from "express";
import * as bolt11 from "bolt11";
import * as lncli from "ln-service";
import {ToBtcLnSwapAbs, ToBtcLnSwapState} from "./ToBtcLnSwapAbs";
import {SwapHandler, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {ChainEvents, ClaimEvent, InitializeEvent,
    IStorageManager,
    RefundEvent, SwapContract, SwapData, SwapEvent, ChainSwapType, TokenAddress} from "crosslightning-base";
import {SwapNonce} from "../SwapNonce";
import {AuthenticatedLnd} from "lightning";

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

    minSendCltv: BN,

    swapCheckInterval: number
};

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
    }

    async checkPastInvoices() {

        for(let key in this.storageManager.data) {
            const invoiceData: ToBtcLnSwapAbs<T> = this.storageManager.data[key];
            const decodedPR = bolt11.decode(invoiceData.pr);

            if (invoiceData.state === ToBtcLnSwapState.SAVED) {
                const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew));
                if(invoiceData.signatureExpiry!=null && invoiceData.signatureExpiry.lt(timestamp)) {
                    //Signature expired
                    await this.storageManager.removeData(invoiceData.getHash());
                    continue;
                }
                //Yet unpaid
                if (decodedPR.timeExpireDate < Date.now() / 1000) {
                    //Expired
                    await this.storageManager.removeData(invoiceData.getHash());
                    continue;
                }
            }

            if (invoiceData.state === ToBtcLnSwapState.COMMITED) {
                await this.processInitialized(invoiceData, invoiceData.data);
            }
        }
    }

    async processPaymentResult(invoiceData: ToBtcLnSwapAbs<T>, lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, is_pending?: boolean, payment?: any}) {
        const decodedPR = bolt11.decode(invoiceData.pr);
        const paymentHash = Buffer.from(decodedPR.tagsObject.payment_hash, "hex");

        if(lnPaymentStatus.is_failed) {
            console.error("[To BTC-LN: BTCLN.PaymentResult] Invoice payment failed, should refund offerer");
            await this.storageManager.removeData(decodedPR.tagsObject.payment_hash);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            return;
        }

        if(lnPaymentStatus.is_confirmed) {
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
                await this.storageManager.removeData(decodedPR.tagsObject.payment_hash);
            }
            unlock();

            return;
        }

        throw new Error("Invalid lnPaymentStatus");
    }

    subscribeToPayment(invoiceData: ToBtcLnSwapAbs<T>) {

        const decodedPR = bolt11.decode(invoiceData.pr);
        if(this.activeSubscriptions.has(decodedPR.tagsObject.payment_hash)) {
            //Already subscribed
            return;
        }

        const sub = lncli.subscribeToPastPayment({id: decodedPR.tagsObject.payment_hash, lnd: this.LND});

        console.log("[To BTC-LN: BTCLN.PaymentResult] Subscribed to payment: ", decodedPR.tagsObject.payment_hash);

        const onResult = (lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, payment?: any}) => {
            this.processPaymentResult(invoiceData, lnPaymentStatus);
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

    async processInitialized(invoiceData: ToBtcLnSwapAbs<T>, data: T) {

        const lnPr = invoiceData.pr;
        const decodedPR = bolt11.decode(lnPr);

        //Check if payment was already made
        let lnPaymentStatus = await lncli.getPayment({
            id: decodedPR.tagsObject.payment_hash,
            lnd: this.LND
        }).catch(e => {
            console.error(e);
        });

        const markAsNonPayable = async() => {
            invoiceData.data = data;
            invoiceData.state = ToBtcLnSwapState.NON_PAYABLE;
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData);
        };

        if(lnPaymentStatus==null) {
            if (!data.isToken(invoiceData.data.getToken())) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid token used");
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] Struct: ", data);

            //const tokenAmount: BN = data.getAmount();
            const expiryTimestamp: BN = data.getExpiry();
            const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));

            console.log("[To BTC-LN: Solana.Initialize] Expiry time: ", expiryTimestamp.toString(10));

            if(expiryTimestamp.sub(currentTimestamp).lt(this.config.minTsSendCltv)) {
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
            // const maxFee = tokenAmount.sub(amountBD).sub(invoiceData.swapFee);
            //
            // console.log("[To BTC-LN: Solana.Initialize] Invoice amount (sats): ", amountBD.toString(10));
            // console.log("[To BTC-LN: Solana.Initialize] Token amount (sats WBTC): ", tokenAmount.toString(10));
            //
            // if(maxFee.lt(new BN(0))) {
            //     console.error("[To BTC-LN: Solana.Initialize] Not enough paid!");
            //     await markAsNonPayable();
            //     return;
            // }

            const maxUsableCLTV = expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

            console.log("[To BTC-LN: Solana.Initialize] Max usable CLTV expiry: ", maxUsableCLTV.toString(10));
            console.log("[To BTC-LN: Solana.Initialize] Max fee: ", maxFee.toString(10));

            invoiceData.state = ToBtcLnSwapState.COMMITED;
            invoiceData.data = data;
            await this.storageManager.saveData(decodedPR.tagsObject.payment_hash, invoiceData);

            const { current_block_height } = await lncli.getHeight({lnd: this.LND});

            const obj: any = {
                request: lnPr,
                max_fee: maxFee.toString(10),
                max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10)
            };

            console.log("[To BTC-LN: Solana.Initialize] Paying invoice: ", obj);

            obj.lnd = this.LND;

            const payment = await lncli.pay(obj).catch(e => {
                console.error(e);
            });

            this.subscribeToPayment(invoiceData);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            this.subscribeToPayment(invoiceData);
            return;
        }

        await this.processPaymentResult(invoiceData, lnPaymentStatus);

    }

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

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

                await this.storageManager.removeData(paymentHash);

                continue;
            }
            if(event instanceof RefundEvent) {
                continue;
            }
        }

        return true;

    }

    startRestServer(restServer: Express) {
        restServer.post(this.path+"/payInvoice", async (req, res) => {
            /**
             * pr: string                   bolt11 lightning invoice
             * maxFee: string               maximum routing fee
             * expiryTimestamp: string      expiry timestamp of the to be created HTLC, determines how many LN paths can be considered
             * token: string                Desired token to use
             */
            try {
                if (
                    req.body == null ||

                    req.body.pr == null ||
                    typeof(req.body.pr) !== "string" ||

                    req.body.maxFee == null ||
                    typeof(req.body.maxFee) !== "string" ||

                    req.body.expiryTimestamp == null ||
                    typeof(req.body.expiryTimestamp) !== "string" ||

                    req.body.token == null ||
                    typeof(req.body.token) !== "string"
                ) {
                    res.status(400).json({
                        msg: "Invalid request body (pr/maxFee/expiryTimestamp/token)"
                    });
                    return;
                }

                if(!this.allowedTokens.has(req.body.token)) {
                    res.status(400).json({
                        msg: "Invalid request body (token)"
                    });
                    return;
                }

                let maxFeeBD: BN;

                try {
                    maxFeeBD = new BN(req.body.maxFee);
                } catch (e) {
                    res.status(400).json({
                        msg: "Invalid request body (maxFee - cannot be parsed)"
                    });
                    return;
                }

                let expiryTimestamp: BN;

                try {
                    expiryTimestamp = new BN(req.body.expiryTimestamp)
                } catch (e) {
                    res.status(400).json({
                        msg: "Invalid request body (expiryTimestamp - cannot be parsed)"
                    });
                    return;
                }
                const currentTimestamp = new BN(Math.floor(Date.now()/1000));

                let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

                try {
                    parsedPR = bolt11.decode(req.body.pr);
                } catch (e) {
                    console.error(e);
                    res.status(400).json({
                        msg: "Invalid request body (pr - cannot be parsed)"
                    });
                    return;
                }

                if(parsedPR.timeExpireDate < Date.now()/1000) {
                    res.status(400).json({
                        msg: "Invalid request body (pr - expired)"
                    });
                    return;
                }

                if(expiryTimestamp.sub(currentTimestamp).lt(this.config.minTsSendCltv)) {
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

                const maxUsableCLTV: BN = expiryTimestamp.sub(currentTimestamp).sub(this.config.gracePeriod).div(this.config.bitcoinBlocktime.mul(this.config.safetyFactor));

                const { current_block_height } = await lncli.getHeight({lnd: this.LND});

                //Probe for a route
                let obj;
                try {
                    const parsedRequest = await lncli.parsePaymentRequest({
                        request: req.body.pr
                    });

                    const probeReq: any = {
                        destination: parsedPR.payeeNodeKey,
                        cltv_delta: parsedPR.tagsObject.min_final_cltv_expiry,
                        mtokens: parsedPR.millisatoshis,
                        max_fee_mtokens: maxFeeBD.mul(new BN(1000)).toString(10),
                        max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10),
                        payment: parsedRequest.payment,
                        total_mtokens: parsedPR.millisatoshis,
                        routes: parsedRequest.routes
                    };
                    //if(hints.length>0) req.routes = [hints];
                    console.log("[To BTC-LN: REST.payInvoice] Probe for route: ", probeReq);
                    probeReq.lnd = this.LND;
                    obj = await lncli.probeForRoute(probeReq);
                } catch (e) {
                    console.log(e);
                }

                console.log("[To BTC-LN: REST.payInvoice] Probe result: ", obj);

                if(obj==null || obj.route==null) {
                    res.status(400).json({
                        code: 20002,
                        msg: "Cannot route the payment!"
                    });
                    return;
                }

                const swapFee = amountBD.mul(this.config.feePPM).div(new BN(1000000)).add(this.config.baseFee);

                const useToken = this.swapContract.toTokenAddress(req.body.token);

                const maxFeeInToken = await this.swapPricing.getFromBtcSwapAmount(maxFeeBD, useToken);
                const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken);
                const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken);

                const total = amountInToken.add(maxFeeInToken).add(swapFeeInToken);

                const payObject: T = this.swapContract.createSwapData(
                    ChainSwapType.HTLC,
                    null,
                    this.swapContract.getAddress(),
                    useToken,
                    total,
                    parsedPR.tagsObject.payment_hash,
                    expiryTimestamp,
                    new BN(0),
                    0,
                    false
                );

                const sigData = await this.swapContract.getClaimInitSignature(payObject, this.nonce, this.config.authorizationTimeout);

                const createdSwap = new ToBtcLnSwapAbs<T>(req.body.pr, swapFee, maxFeeBD, new BN(sigData.timeout));
                createdSwap.data = payObject;

                await this.storageManager.saveData(parsedPR.tagsObject.payment_hash, createdSwap);

                res.status(200).json({
                    code: 20000,
                    msg: "Success",
                    data: {
                        maxFee: maxFeeInToken.toString(10),
                        swapFee: swapFeeInToken.toString(10),
                        total: total.toString(10),
                        confidence: obj.route.confidence/1000000,
                        address: this.swapContract.getAddress(),

                        data: payObject.serialize(),

                        nonce: sigData.nonce,
                        prefix: sigData.prefix,
                        timeout: sigData.timeout,
                        signature: sigData.signature
                    }
                });

            } catch(e) {
                console.error(e);
                res.status(500).send("Server error");
            }
        });

        restServer.post(this.path+'/getRefundAuthorization', async (req, res) => {
            /**
             * paymentHash: string          Identifier of the swap
             */
            if (
                req.body == null ||

                req.body.paymentHash == null ||
                typeof(req.body.paymentHash) !== "string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            const data = this.storageManager.data[req.body.paymentHash];

            if(data!=null) {
                if(data.state===ToBtcLnSwapState.NON_PAYABLE) {
                    const hash = Buffer.from(req.body.paymentHash, "hex");

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
                id: req.body.paymentHash,
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
                const commitedData = await this.swapContract.getCommitedData(req.body.paymentHash);

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

        console.log("[To BTC-LN: REST] Started at path: ", this.path);

    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[To BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastInvoices();
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    async init() {
        await this.storageManager.loadData(ToBtcLnSwapAbs);
        this.subscribeToEvents();
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
