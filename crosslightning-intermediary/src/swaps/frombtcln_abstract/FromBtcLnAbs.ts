import * as BN from "bn.js";
import {Express} from "express";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
import {SwapNonce} from "../SwapNonce";
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
import {expressHandlerWrapper, FieldTypeEnum, HEX_REGEX, verifySchema} from "../../utils/Utils";

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

    minCltv: BN,

    refundInterval: number,

    securityDepositAPY: number
}

const secondsInYear = new BN(365*24*60*60);

/**
 * Swap handler handling from BTCLN swaps using submarine swaps
 */
export class FromBtcLnAbs<T extends SwapData> extends SwapHandler<FromBtcLnSwapAbs<T>, T> {

    readonly type = SwapHandlerType.FROM_BTCLN;

    readonly config: FromBtcLnConfig;

    constructor(
        storageDirectory: IStorageManager<FromBtcLnSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any>,
        chainEvents: ChainEvents<T>,
        swapNonce: SwapNonce,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcLnConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, swapNonce, allowedTokens, lnd, swapPricing);
        this.config = config;
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    private async checkPastSwaps() {

        const settleInvoices: string[] = [];
        const cancelInvoices: string[] = [];
        const refundSwaps: FromBtcLnSwapAbs<T>[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

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
                        cancelInvoices.push(parsedPR.tagsObject.payment_hash);
                        continue;
                    }
                }

            }

            const expiryTime = swap.data.getExpiry();
            const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

            if(swap.state===FromBtcLnSwapState.CLAIMED) {
                //Try to settle the hodl invoice
                settleInvoices.push(swap.secret);
                continue;
            }

            if(swap.state===FromBtcLnSwapState.CANCELED) {
                cancelInvoices.push(swap.data.getHash());
                continue;
            }

            const isExpired = expiryTime!=null && expiryTime.lt(currentTime);
            if(isExpired) {
                const isCommited = await this.swapContract.isCommited(swap.data);

                if(isCommited) {
                    refundSwaps.push(swap);
                    continue;
                }

                cancelInvoices.push(swap.data.getHash());
            }
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;

            await this.swapContract.refund(refundSwap.data, true, false, true);

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
                await this.storageManager.removeData(paymentHash);
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash);
            }
        }

        for(let secret of settleInvoices) {
            //Refund
            const secretBuffer = Buffer.from(secret, "hex");
            const paymentHash = createHash("sha256").update(secretBuffer).digest();

            try {
                await lncli.settleHodlInvoice({
                    lnd: this.LND,
                    secret: secret
                });

                console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHash.toString("hex"));
                await this.storageManager.removeData(paymentHash.toString("hex"));
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash.toString("hex"));
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
                if (!this.swapContract.areWeOfferer(event.swapData)) {
                    continue;
                }

                if (event.swapData.isPayIn()) {
                    continue;
                }

                if (event.swapData.getType() !== ChainSwapType.HTLC) {
                    //Only process HTLC requests
                    continue;
                }

                //Increment nonce
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");

                const savedSwap = this.storageManager.data[paymentHash];

                const isSwapFound = savedSwap != null;
                if (isSwapFound) {
                    savedSwap.state = FromBtcLnSwapState.COMMITED;
                }

                const usedNonce = event.signatureNonce;
                const tokenAdress = event.swapData.getToken().toString();
                const shouldUpdateNonce = usedNonce > this.nonce.getNonce(tokenAdress);
                if (shouldUpdateNonce) {
                    await this.nonce.saveNonce(tokenAdress,usedNonce);
                }

                if (isSwapFound) {
                    savedSwap.data = event.swapData;
                    await this.storageManager.saveData(paymentHashBuffer.toString("hex"), savedSwap);
                }

            }
            if(event instanceof ClaimEvent) {
                //Claim
                //This is the important part, we need to catch the claim TX, else we may lose money
                const secret: Buffer = Buffer.from(event.secret, "hex");
                const paymentHash: Buffer = createHash("sha256").update(secret).digest();

                const secretHex = secret.toString("hex");
                const paymentHashHex = paymentHash.toString("hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                const isSwapFound = savedSwap != null;
                if (!isSwapFound) {
                    continue;
                }

                try {
                    await lncli.settleHodlInvoice({
                        lnd: this.LND,
                        secret: secretHex
                    });
                    console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHashHex);
                    await this.storageManager.removeData(paymentHashHex);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] FATAL Cannot settle hodl invoice id: " + paymentHashHex + " secret: ", secretHex);
                    savedSwap.state = FromBtcLnSwapState.CLAIMED;
                    savedSwap.secret = secretHex;
                    await this.storageManager.saveData(paymentHashHex, savedSwap);
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

                const savedSwap = this.storageManager.data[event.paymentHash];

                const isSwapFound = savedSwap != null;
                if (!isSwapFound) {
                    continue;
                }

                try {
                    await lncli.cancelHodlInvoice({
                        lnd: this.LND,
                        id: event.paymentHash
                    });
                    console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was refunded, id: ", event.paymentHash);
                    await this.storageManager.removeData(event.paymentHash);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", event.paymentHash);
                    savedSwap.state = FromBtcLnSwapState.CANCELED;
                    await this.storageManager.saveData(event.paymentHash, savedSwap);
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
        const useToken: TokenAddress = invoiceData.data.getToken();

        const balance: BN = await this.swapContract.getBalance(useToken, true);

        const invoiceAmount: BN = new BN(invoice.received);
        const fee: BN = invoiceData.swapFee;

        const invoiceAmountInToken = await this.swapPricing.getFromBtcSwapAmount(invoiceAmount, useToken);
        const feeInToken = await this.swapPricing.getFromBtcSwapAmount(fee, useToken);

        const sendAmount: BN = invoiceAmountInToken.sub(feeInToken);

        const cancelAndRemove = async () => {
            if(invoiceData.state!==FromBtcLnSwapState.CREATED) return;
            invoiceData.state = FromBtcLnSwapState.CANCELED;
            await lncli.cancelHodlInvoice({
                id: invoice.id,
                lnd: this.LND
            });
            await this.storageManager.removeData(invoice.id);
        };

        const hasEnoughBalance = balance.gte(sendAmount);
        if (!hasEnoughBalance) {
            await cancelAndRemove();
            console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] ERROR Not enough balance on smart chain to honor the request");
            throw {
                code: 20001,
                msg: "Not enough liquidity"
            };
        }

        let timeout: number = null;
        invoice.payments.forEach((curr) => {
            if (timeout == null || timeout > curr.timeout) timeout = curr.timeout;
        });
        const {current_block_height} = await lncli.getHeight({lnd: this.LND});

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

        const payInvoiceObject: T = await this.swapContract.createSwapData(
            ChainSwapType.HTLC,
            this.swapContract.getAddress(),
            invoice.description,
            useToken,
            sendAmount,
            invoice.id,
            new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout),
            new BN(0),
            0,
            false,
            true,
            invoiceData.data.getSecurityDeposit(),
            new BN(0)
        );

        if(invoiceData.state===FromBtcLnSwapState.CREATED) {
            invoiceData.data = payInvoiceObject;
            invoiceData.state = FromBtcLnSwapState.RECEIVED;
            await this.storageManager.saveData(invoice.id, invoiceData);
        }
    }

    startRestServer(restServer: Express) {

        restServer.post(this.path+"/createInvoice", expressHandlerWrapper(async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * paymentHash: string          payment hash of the to-be-created invoice
             * amount: string               amount (in sats) of the invoice
             * expiry: number               expiry time of the invoice (in seconds)
             * token: string                Desired token to swap
             */

            const parsedBody = verifySchema(req.body, {
                address: (val: string) => val!=null &&
                            typeof(val)==="string" &&
                            this.swapContract.isValidAddress(val) ? val : null,
                paymentHash: (val: string) => val!=null &&
                            typeof(val)==="string" &&
                            val.length===64 &&
                            HEX_REGEX.test(val) ? val: null,
                amount: FieldTypeEnum.BN,
                expiry: FieldTypeEnum.Number,
                token: (val: string) => val!=null &&
                        typeof(val)!=="string" &&
                        this.allowedTokens.has(val) ? val : null
            });

            if(parsedBody==null) {
                res.status(400).json({
                    msg: "Invalid request body"
                });
                return;
            }

            if(parsedBody.amount.lt(this.config.min)) {
                res.status(400).json({
                    msg: "Amount too low"
                });
                return;
            }

            if(parsedBody.amount.gt(this.config.max)) {
                res.status(400).json({
                    msg: "Amount too high"
                });
                return;
            }

            if(parsedBody.expiry<=0) {
                res.status(400).json({
                    msg: "Invalid request body (expiry)"
                });
                return;
            }

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);
            const swapFee = this.config.baseFee.add(parsedBody.amount.mul(this.config.feePPM).div(new BN(1000000)));

            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(parsedBody.amount, useToken);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken);

            const balance = await this.swapContract.getBalance(useToken, true);

            const totalSwapOut = amountInToken.sub(swapFeeInToken);

            const hasEnoughBalance = balance.gte(totalSwapOut);
            if(!hasEnoughBalance) {
                res.status(400).json({
                    msg: "Not enough liquidity"
                });
                return;
            }

            const hodlInvoiceObj: any = {
                description: parsedBody.address,
                cltv_delta: this.config.minCltv.add(new BN(5)).toString(10),
                expires_at: new Date(Date.now()+(parsedBody.expiry*1000)).toISOString(),
                id: parsedBody.paymentHash,
                tokens: parsedBody.amount.toString(10)
            };

            console.log("[From BTC-LN: REST.CreateInvoice] creating hodl invoice: ", hodlInvoiceObj);

            hodlInvoiceObj.lnd = this.LND;

            const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);

            console.log("[From BTC-LN: REST.CreateInvoice] hodl invoice created: ", hodlInvoice);

            const createdSwap = new FromBtcLnSwapAbs<T>(hodlInvoice.request, swapFee);

            //Pre-compute the security deposit
            const expiryTimeout = this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);

            let baseSD: BN;
            //Solana workaround
            if((this.swapContract as any).getRawRefundFee!=null) {
                baseSD = await (this.swapContract as any).getRawRefundFee();
            } else {
                baseSD = (await this.swapContract.getRefundFee()).mul(new BN(2));
            }

            const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(parsedBody.amount.sub(swapFee), this.swapContract.getNativeCurrencyAddress());
            const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));
            const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);

            const totalSecurityDeposit = baseSD.add(variableSD);

            createdSwap.data = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                null,
                parsedBody.paymentHash,
                null,
                null,
                0,
                false,
                true,
                totalSecurityDeposit,
                new BN(0)
            );

            await this.storageManager.saveData(parsedBody.paymentHash, createdSwap);

            res.status(200).json({
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFeeInToken.toString(10),
                    total: totalSwapOut.toString(10),
                    intermediaryKey: this.swapContract.getAddress(),
                    securityDeposit: totalSecurityDeposit.toString(10)
                }
            });

        }));


        restServer.post(this.path+"/getInvoiceStatus", expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            const parsedBody = verifySchema(req.body, {
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

        }));

        restServer.post(this.path+"/getInvoicePaymentAuth", expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            const parsedBody = verifySchema(req.body, {
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

            const invoiceData: FromBtcLnSwapAbs<T> = this.storageManager.data[req.body.paymentHash];

            const isSwapFound = invoiceData != null;
            if (!isSwapFound) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
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

            const sigData = await this.swapContract.getInitSignature(invoiceData.data, this.nonce, this.config.authorizationTimeout);

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    address: this.swapContract.getAddress(),
                    data: invoiceData.serialize().data,
                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });
        }));

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

