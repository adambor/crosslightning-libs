import * as BN from "bn.js";
import {Express} from "express";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
import {SwapNonce} from "../SwapNonce";
import {SwapHandler, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {ChainEvents, ClaimEvent, InitializeEvent,
    IStorageManager,
    RefundEvent, SwapContract, SwapData, SwapEvent, ChainSwapType, TokenAddress} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {ToBtcSwapAbs} from "../..";

const HEX_REGEX = /[0-9a-fA-F]+/;

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

    async checkPastSwaps() {

        const removeSwaps: string[] = [];
        const settleInvoices: string[] = [];
        const cancelInvoices: string[] = [];
        const refundSwaps: FromBtcLnSwapAbs<T>[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

            if(swap.state===FromBtcLnSwapState.CREATED) {
                const parsedPR = bolt11.decode(swap.pr);
                //Invoice is expired
                if(parsedPR.timeExpireDate<Date.now()/1000) {
                    //Check if it really wasn't paid
                    const invoice = await lncli.getInvoice({
                        id: parsedPR.tagsObject.payment_hash,
                        lnd: this.LND
                    });

                    if(!invoice.is_held) {
                        //Remove
                        removeSwaps.push(parsedPR.tagsObject.payment_hash);
                    }
                }
                continue;
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

            if(expiryTime.lt(currentTime)) {
                const isCommited = await this.swapContract.isCommited(swap.data);

                if(isCommited) {
                    refundSwaps.push(swap);
                    continue;
                }

                cancelInvoices.push(swap.data.getHash());
            }
        }

        for(let swapHash of removeSwaps) {
            await this.storageManager.removeData(swapHash);
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

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

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

                if (savedSwap != null) {
                    savedSwap.state = FromBtcLnSwapState.COMMITED;
                }

                const usedNonce = event.signatureNonce;
                const tokenAdress = event.swapData.getToken().toString();
                if (usedNonce > this.nonce.getNonce(tokenAdress)) {
                    await this.nonce.saveNonce(tokenAdress,usedNonce);
                }

                if (savedSwap != null) {
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

                if (savedSwap == null) {
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

                if (savedSwap == null) {
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

    startRestServer(restServer: Express) {

        restServer.post(this.path+"/createInvoice", async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * paymentHash: string          payment hash of the to-be-created invoice
             * amount: string               amount (in sats) of the invoice
             * expiry: number               expiry time of the invoice (in seconds)
             * token: string                Desired token to swap
             */
            if(
                req.body==null ||
                req.body.token==null ||
                typeof(req.body.token)!=="string" ||
                !this.allowedTokens.has(req.body.token)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (token)"
                });
                return;
            }

            if(
                req.body.address==null ||
                typeof(req.body.address)!=="string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (address)"
                });
                return;
            }

            try {
                if(!this.swapContract.isValidAddress(req.body.address)) {
                    res.status(400).json({
                        msg: "Invalid request body (address)"
                    });
                    return;
                }
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (address)"
                });
                return;
            }

            if(
                req.body.paymentHash==null ||
                typeof(req.body.paymentHash)!=="string" ||
                req.body.paymentHash.length!==64 ||
                !HEX_REGEX.test(req.body.paymentHash)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            if(
                req.body.amount==null ||
                typeof(req.body.amount)!=="string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (amount)"
                });
                return;
            }

            let amountBD: BN;
            try {
                amountBD = new BN(req.body.amount);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (amount)"
                });
                return;
            }

            if(amountBD.lt(this.config.min)) {
                res.status(400).json({
                    msg: "Amount too low"
                });
                return;
            }

            if(amountBD.gt(this.config.max)) {
                res.status(400).json({
                    msg: "Amount too high"
                });
                return;
            }

            const useToken = this.swapContract.toTokenAddress(req.body.token);
            const swapFee = this.config.baseFee.add(amountBD.mul(this.config.feePPM).div(new BN(1000000)));

            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken);

            const balance = await this.swapContract.getBalance(useToken, true);

            if(amountInToken.sub(swapFeeInToken).gt(balance)) {
                res.status(400).json({
                    msg: "Not enough liquidity"
                });
                return;
            }

            if(
                req.body.expiry==null ||
                typeof(req.body.expiry)!=="number" ||
                isNaN(req.body.expiry) ||
                req.body.expiry<=0
            ) {
                res.status(400).json({
                    msg: "Invalid request body (expiry)"
                });
                return;
            }

            const hodlInvoiceObj: any = {
                description: req.body.address,
                cltv_delta: this.config.minCltv.toString(10),
                expires_at: new Date(Date.now()+(req.body.expiry*1000)).toISOString(),
                id: req.body.paymentHash,
                tokens: amountBD.toString(10)
            };

            console.log("[From BTC-LN: REST.CreateInvoice] creating hodl invoice: ", hodlInvoiceObj);

            hodlInvoiceObj.lnd = this.LND;

            const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);

            console.log("[From BTC-LN: REST.CreateInvoice] hodl invoice created: ", hodlInvoice);

            const paymentHash = Buffer.from(req.body.paymentHash, "hex");
            const createdSwap = new FromBtcLnSwapAbs<T>(hodlInvoice.request, swapFee);

            createdSwap.data = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                this.swapContract.getAddress(),
                req.body.address, useToken,
                null,
                req.body.paymentHash,
                null,
                null,
                0,
                false,
                true,
                new BN(0),
                new BN(0)
            );

            await this.storageManager.saveData(req.body.paymentHash, createdSwap);

            res.status(200).json({
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFeeInToken.toString(10),
                    total: amountInToken.sub(swapFeeInToken).toString(10)
                }
            });

        });


        restServer.post(this.path+"/getInvoiceStatus", async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            if (
                req.body == null ||

                req.body.paymentHash == null ||
                typeof(req.body.paymentHash) !== "string" ||
                req.body.paymentHash.length !== 64
            ) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            const invoice = await lncli.getInvoice({
                id: req.body.paymentHash,
                lnd: this.LND
            });

            if(invoice==null) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            try {
                if(!this.swapContract.isValidAddress(invoice.description)) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }
            } catch (e) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (!invoice.is_held) {
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

        restServer.post(this.path+"/getInvoicePaymentAuth", async (req, res) => {
            try {
                /**
                 * paymentHash: string          payment hash of the invoice
                 */
                if (
                    req.body == null ||

                    req.body.paymentHash == null ||
                    typeof(req.body.paymentHash) !== "string" ||
                    req.body.paymentHash.length !== 64
                ) {
                    res.status(400).json({
                        msg: "Invalid request body (paymentHash)"
                    });
                    return;
                }

                const invoice = await lncli.getInvoice({
                    id: req.body.paymentHash,
                    lnd: this.LND
                });

                if (invoice == null) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                try {
                    if (!this.swapContract.isValidAddress(invoice.description)) {
                        res.status(200).json({
                            code: 10001,
                            msg: "Invoice expired/canceled"
                        });
                        return;
                    }
                } catch (e) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                if (!invoice.is_held) {
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

                const paymentHash = Buffer.from(req.body.paymentHash, "hex");
                const invoiceData: FromBtcLnSwapAbs<T> = this.storageManager.data[req.body.paymentHash];

                if (invoiceData == null) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                if (invoiceData.state === FromBtcLnSwapState.CREATED) {
                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] held ln invoice: ", invoice);

                    const useToken: TokenAddress = invoiceData.data.getToken();

                    const balance: BN = await this.swapContract.getBalance(useToken, true);

                    const invoiceAmount: BN = new BN(invoice.received);
                    const fee: BN = invoiceData.swapFee;

                    const invoiceAmountInToken = await this.swapPricing.getFromBtcSwapAmount(invoiceAmount, useToken);
                    const feeInToken = await this.swapPricing.getFromBtcSwapAmount(fee, useToken);

                    const sendAmount: BN = invoiceAmountInToken.sub(feeInToken);

                    const cancelAndRemove = async () => {
                        await lncli.cancelHodlInvoice({
                            id: invoice.id,
                            lnd: this.LND
                        });
                        await this.storageManager.removeData(paymentHash.toString("hex"));
                    };

                    if (balance.lt(sendAmount)) {
                        await cancelAndRemove();
                        console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] ERROR Not enough balance on SOL to honor the request");
                        res.status(200).json({
                            code: 20001,
                            msg: "Not enough liquidity"
                        });
                        return;
                    }

                    let timeout: number = null;
                    invoice.payments.forEach((curr) => {
                        if (timeout == null || timeout > curr.timeout) timeout = curr.timeout;
                    });
                    const {current_block_height} = await lncli.getHeight({lnd: this.LND});

                    const blockDelta = new BN(timeout - current_block_height);

                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] block delta: ", blockDelta.toString(10));

                    const expiryTimeout = blockDelta.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);

                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] expiry timeout: ", expiryTimeout.toString(10));

                    if (expiryTimeout.isNeg()) {
                        await cancelAndRemove();
                        console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] Expire time is lower than 0");
                        res.status(200).json({
                            code: 20002,
                            msg: "Not enough time to reliably process the swap"
                        });
                        return;
                    }

                    const baseSD = (await this.swapContract.getRefundFee()).mul(new BN(2));

                    const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(invoiceAmount.sub(fee), this.swapContract.getNativeCurrencyAddress());

                    const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));

                    const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);

                    /*
                    {
                        intermediary: new PublicKey(invoice.description),
                        token: WBTC_ADDRESS,
                        amount: sendAmount,
                        paymentHash: req.body.paymentHash,
                        expiry: new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout)
                    }
                     */
                    const payInvoiceObject: T = await this.swapContract.createSwapData(
                        ChainSwapType.HTLC,
                        this.swapContract.getAddress(),
                        invoice.description,
                        useToken,
                        sendAmount,
                        req.body.paymentHash,
                        new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout),
                        new BN(0),
                        0,
                        false,
                        true,
                        baseSD.add(variableSD),
                        new BN(0)
                    );

                    invoiceData.data = payInvoiceObject;
                    invoiceData.state = FromBtcLnSwapState.RECEIVED;
                    await this.storageManager.saveData(paymentHash.toString("hex"), invoiceData);
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
            } catch (e) {
                console.error(e);
                res.status(500).json({
                    msg: "Internal server error"
                });
            }
        });

        console.log("[From BTC-LN: REST] Started at path: ", this.path);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps();
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

