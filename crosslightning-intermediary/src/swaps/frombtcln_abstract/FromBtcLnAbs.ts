import * as BN from "bn.js";
import {Express} from "express";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
import {SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    ChainEvents,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapContract,
    SwapData,
    TokenAddress
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {FromBtcBaseConfig, FromBtcBaseSwapHandler} from "../FromBtcBaseSwapHandler";

export type FromBtcLnConfig = FromBtcBaseConfig & {
    invoiceTimeoutSeconds?: number,
    minCltv: BN
}

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
export class FromBtcLnAbs<T extends SwapData> extends FromBtcBaseSwapHandler<FromBtcLnSwapAbs<T>, T> {

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
    protected async processPastSwaps() {

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

    protected async processInitializeEvent(event: InitializeEvent<T>): Promise<void> {
        //Only process HTLC requests
        if (event.swapType !== ChainSwapType.HTLC) return;

        const swapData = await event.swapData();

        if (!this.swapContract.areWeOfferer(swapData)) return;
        if (swapData.isPayIn()) return;

        const paymentHash = event.paymentHash;

        const savedSwap = await this.storageManager.getData(paymentHash, null);
        if (savedSwap==null) return;

        savedSwap.txIds.init = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();
        if(savedSwap.state===FromBtcLnSwapState.CREATED) {
            await savedSwap.setState(FromBtcLnSwapState.COMMITED);
            savedSwap.data = swapData;
            await this.storageManager.saveData(paymentHash, null, savedSwap);
        }
    }

    protected async processClaimEvent(event: ClaimEvent<T>): Promise<void> {
        //Claim
        //This is the important part, we need to catch the claim TX, else we may lose money
        const secret: Buffer = Buffer.from(event.secret, "hex");
        const paymentHash: Buffer = createHash("sha256").update(secret).digest();
        const secretHex = secret.toString("hex");
        const paymentHashHex = paymentHash.toString("hex");

        const savedSwap = await this.storageManager.getData(paymentHashHex, null);
        if (savedSwap==null) return ;

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
            await this.removeSwapData(paymentHashHex, null);
        } catch (e) {
            console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] FATAL Cannot settle hodl invoice id: " + paymentHashHex + " secret: ", secretHex);
            savedSwap.secret = secretHex;
            await savedSwap.setState(FromBtcLnSwapState.CLAIMED);
            await this.storageManager.saveData(paymentHashHex, null, savedSwap);
        }

    }

    protected async processRefundEvent(event: RefundEvent<T>): Promise<void> {
        //Refund
        //Try to get the hash from the refundMap
        if (event.paymentHash == null) return;

        const savedSwap = await this.storageManager.getData(event.paymentHash, null);
        if (savedSwap==null) return;

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
    }

    /**
     * Called when lightning HTLC is received, also signs an init transaction on the smart chain side, expiry of the
     *  smart chain authorization starts ticking as soon as this HTLC is received
     *
     * @param invoiceData
     * @param invoice
     */
    private async htlcReceived(invoiceData: FromBtcLnSwapAbs<T>, invoice: any) {
        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcReceived = Date.now();

        const useToken: TokenAddress = invoiceData.data.getToken();
        const sendAmount: BN = invoiceData.data.getAmount();

        //Create abort controller for parallel fetches
        const abortController = new AbortController();

        //Pre-fetch data
        const balancePrefetch: Promise<BN> = this.getBalancePrefetch(useToken, abortController);
        const blockheightPrefetch = this.getBlockheightPrefetch(abortController);
        const signDataPrefetchPromise: Promise<any> = this.getSignDataPrefetch(abortController);

        let expiryTimeout: BN;
        try {
            //Check if we have enough liquidity to proceed
            await this.checkBalance(sendAmount, balancePrefetch, abortController.signal);
            if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcBalanceChecked = Date.now();

            //Check if HTLC expiry is long enough
            expiryTimeout = await this.checkHtlcExpiry(invoice, blockheightPrefetch, abortController.signal);
            if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcTimeoutCalculated = Date.now();
        } catch (e) {
            if(!abortController.signal.aborted) {
                if(invoiceData.state===FromBtcLnSwapState.CREATED) await this.cancelSwapAndInvoice(invoiceData);
            }
            throw e;
        }
        console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] expiry timeout: ", expiryTimeout.toString(10));

        //Create real swap data
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

        //Sign swap data
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

    /**
     * Checks invoice description hash
     *
     * @param descriptionHash
     * @throws {DefinedRuntimeError} will throw an error if the description hash is invalid
     */
    checkDescriptionHash(descriptionHash: string) {
        if(descriptionHash!=null) {
            if(typeof(descriptionHash)!=="string" || !HEX_REGEX.test(descriptionHash) || descriptionHash.length!==64) {
                throw {
                    code: 20100,
                    msg: "Invalid request body"
                };
            }
        }
    }

    /**
     * Checks if the request should be processed by calling plugins
     *
     * @param req
     * @param parsedBody
     * @param metadata
     * @throws {DefinedRuntimeError} will throw an error if the plugin cancelled the request
     */
    async checkPlugins(req: Request & {paramReader: IParamReader}, parsedBody: FromBtcLnRequestType, metadata: any): Promise<{baseFee: BN, feePPM: BN}> {
        const pluginResult = await PluginManager.onSwapRequestFromBtcLn(req, parsedBody, metadata);

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

    /**
     * Checks if we have enough inbound liquidity to be able to receive an LN payment (without MPP)
     *
     * @param amountBD
     * @param channelsPrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there isn't enough inbound liquidity to receive the LN payment
     */
    async checkInboundLiquidity(amountBD: BN, channelsPrefetch: Promise<{channels: any[]}>, signal: AbortSignal) {
        const channelsResponse = await channelsPrefetch;

        signal.throwIfAborted();

        let hasEnoughInboundLiquidity = false;
        channelsResponse.channels.forEach(channel => {
            if(new BN(channel.remote_balance).gte(amountBD)) hasEnoughInboundLiquidity = true;
        });
        if(!hasEnoughInboundLiquidity) {
            throw {
                code: 20050,
                msg: "Not enough LN inbound liquidity"
            };
        }
    }

    /**
     * Starts LN channels pre-fetch
     *
     * @param abortController
     */
    getChannelsPrefetch(abortController: AbortController): Promise<{channels: any[]}> {
        return lncli.getChannels({is_active: true, lnd: this.LND}).catch(e => {
            console.error("From BTC-LN: REST.channelsPrefetch", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Starts LN channels pre-fetch
     *
     * @param abortController
     */
    getBlockheightPrefetch(abortController: AbortController): Promise<number> {
        return lncli.getHeight({lnd: this.LND}).then(res => res.current_block_height).catch(e => {
            console.error("From BTC-LN: HTLC-Received.blockheightPrefetch", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Asynchronously sends the LN node's public key to the client, so he can pre-fetch the node's channels from 1ml api
     *
     * @param responseStream
     */
    sendPublicKeyAsync(responseStream: ServerParamEncoder) {
        lncli.getWalletInfo({lnd: this.LND}).then(resp => responseStream.writeParams({
            lnPublicKey: resp.public_key
        })).catch(e => {
            console.error("From BTC-LN: REST.getWalletInfo", e);
        });
    }

    /**
     * Returns the CLTV timeout (blockheight) of the received HTLC corresponding to the invoice. If multiple HTLCs are
     *  received (MPP) it returns the lowest of the timeouts
     *
     * @param invoice
     */
    getInvoicePaymentsTimeout(invoice: {payments: {timeout: number}[]}) {
        let timeout: number = null;
        invoice.payments.forEach((curr) => {
            if (timeout == null || timeout > curr.timeout) timeout = curr.timeout;
        });
        return timeout;
    }

    /**
     * Checks if the received HTLC's CLTV timeout is large enough to still process the swap
     *
     * @param invoice
     * @param blockheightPrefetch
     * @param signal
     * @throws {DefinedRuntimeError} Will throw if HTLC expires too soon and therefore cannot be processed
     * @returns expiry timeout in seconds
     */
    async checkHtlcExpiry(invoice: {payments: {timeout: number}[]}, blockheightPrefetch: Promise<number>, signal: AbortSignal): Promise<BN> {
        const timeout: number = this.getInvoicePaymentsTimeout(invoice);
        const current_block_height = await blockheightPrefetch;
        signal.throwIfAborted();

        const blockDelta = new BN(timeout - current_block_height);

        const htlcExpiresTooSoon = blockDelta.lt(this.config.minCltv);
        if(htlcExpiresTooSoon) {
            console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] Receive HTLC expires too soon (required: "+this.config.minCltv.toString(10)+", got: "+blockDelta.toString(10)+")");
            throw {
                code: 20002,
                msg: "Not enough time to reliably process the swap"
            };
        }
        console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] using cltv delta: ", this.config.minCltv.toString(10));
        return this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);
    }

    /**
     * Cancels the swap (CANCELED state) & also cancels the LN invoice (including all pending HTLCs)
     *
     * @param invoiceData
     */
    async cancelSwapAndInvoice(invoiceData: FromBtcLnSwapAbs<T>): Promise<void> {
        if(invoiceData.state!==FromBtcLnSwapState.CREATED) return;
        await invoiceData.setState(FromBtcLnSwapState.CANCELED);
        const paymentHash = invoiceData.data.getHash();
        await lncli.cancelHodlInvoice({
            id: paymentHash,
            lnd: this.LND
        });
        await this.removeSwapData(paymentHash, null);
    };

    getDummySwapData(useToken: TokenAddress, address: string, paymentHash: string) {
        return this.swapContract.createSwapData(
            ChainSwapType.HTLC,
            this.swapContract.getAddress(),
            address,
            useToken,
            null,
            paymentHash,
            new BN(0),
            null,
            null,
            0,
            false,
            true,
            null,
            new BN(0)
        );
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
            if(parsedBody==null) {
                throw {
                    code: 20100,
                    msg: "Invalid request body"
                };
            }
            metadata.request = parsedBody;

            //Check request params
            this.checkDescriptionHash(parsedBody.descriptionHash);
            const {baseFee, feePPM} = await this.checkPlugins(req, parsedBody, metadata);
            metadata.times.requestChecked = Date.now();

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            //Create abortController for parallel prefetches
            const responseStream = res.responseStream;
            const abortController = this.getAbortController(responseStream);

            //Pre-fetch data
            const {pricePrefetchPromise, securityDepositPricePrefetchPromise} = this.getFromBtcPricePrefetches(useToken, abortController);
            const balancePrefetch: Promise<BN> = this.getBalancePrefetch(useToken, abortController);
            const channelsPrefetch: Promise<{channels: any[]}> = this.getChannelsPrefetch(abortController);

            const dummySwapData = await this.getDummySwapData(useToken, parsedBody.address, parsedBody.paymentHash);
            abortController.signal.throwIfAborted();
            const baseSDPromise: Promise<BN> = this.getBaseSecurityDepositPrefetch(dummySwapData, abortController);

            //Asynchronously send the node's public key to the client
            this.sendPublicKeyAsync(responseStream);

            //Check valid amount specified (min/max)
            const {
                amountBD,
                swapFee,
                swapFeeInToken,
                totalInToken
            } = await this.checkFromBtcAmount(parsedBody.exactOut, parsedBody.amount, useToken, {baseFee, feePPM}, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            //Check if we have enough funds to honor the request
            await this.checkBalance(totalInToken, balancePrefetch, abortController.signal)
            await this.checkInboundLiquidity(amountBD, channelsPrefetch, abortController.signal);
            metadata.times.balanceChecked = Date.now();

            //Create swap
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
            const totalSecurityDeposit = await this.getSecurityDeposit(
                amountBD, swapFee, expiryTimeout,
                baseSDPromise, securityDepositPricePrefetchPromise,
                abortController.signal, metadata
            );
            metadata.times.securityDepositCalculated = Date.now();

            //Create swap data
            createdSwap.data = await this.swapContract.createSwapData(
                ChainSwapType.HTLC,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                totalInToken,
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

            //Save the desired fee rate for the signature
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
                    total: totalInToken.toString(10),
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
                return;
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

            const swap: FromBtcLnSwapAbs<T> = await this.storageManager.getData(parsedBody.paymentHash, null);

            const isSwapFound = swap != null;
            if (!isSwapFound) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (swap.state === FromBtcLnSwapState.RECEIVED) {
                if (swap.signature!=null && await this.swapContract.isInitAuthorizationExpired(swap.data, swap.timeout, swap.prefix, swap.signature)) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }
            }

            if (swap.state === FromBtcLnSwapState.CREATED) {
                console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] held ln invoice: ", invoice);

                try {
                    await this.htlcReceived(swap, invoice);
                } catch (e) {
                    res.status(200).json(e);
                    return;
                }
            }

            if (swap.state === FromBtcLnSwapState.CANCELED) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (swap.state === FromBtcLnSwapState.COMMITED) {
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
                    data: swap.serialize().data,
                    nonce: swap.nonce,
                    prefix: swap.prefix,
                    timeout: swap.timeout,
                    signature: swap.signature
                }
            });
        });

        restServer.post(this.path+"/getInvoicePaymentAuth", getInvoicePaymentAuth);
        restServer.get(this.path+"/getInvoicePaymentAuth", getInvoicePaymentAuth);

        console.log("[From BTC-LN: REST] Started at path: ", this.path);
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

