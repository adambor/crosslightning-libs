import * as BN from "bn.js";
import {Express, Request, Response} from "express";
import {createHash, randomBytes} from "crypto";
import * as bolt11 from "@atomiqlabs/bolt11";
import {
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapData,
} from "crosslightning-base";
import {
    AuthenticatedLnd,
    cancelHodlInvoice,
    createHodlInvoice,
    getInvoice, GetInvoiceResult,
    settleHodlInvoice,
    subscribeToInvoice, SubscribeToInvoiceInvoiceUpdatedEvent
} from "lightning";
import {FromBtcLnTrustedSwap, FromBtcLnTrustedSwapState} from "./FromBtcLnTrustedSwap";
import {FromBtcBaseConfig, FromBtcBaseSwapHandler} from "../FromBtcBaseSwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {MultichainData, SwapHandlerType} from "../SwapHandler";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {PluginManager} from "../../plugins/PluginManager";
import {FromBtcLnBaseSwapHandler} from "../FromBtcLnBaseSwapHandler";
import EventEmitter from "node:events";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";

export type SwapForGasServerConfig = FromBtcBaseConfig & {
    minCltv: BN,

    invoiceTimeoutSeconds?: number
}

export type FromBtcLnTrustedRequestType = {
    address: string,
    amount: BN,
    exactOut?: boolean
};

/**
 * Swap handler handling from BTCLN swaps using submarine swaps
 */
export class FromBtcLnTrusted extends FromBtcLnBaseSwapHandler<FromBtcLnTrustedSwap, FromBtcLnTrustedSwapState> {
    readonly type: SwapHandlerType = SwapHandlerType.FROM_BTCLN_TRUSTED;

    activeSubscriptions: Map<string, EventEmitter> = new Map<string, EventEmitter>();
    processedTxIds: Map<string, string> = new Map<string, string>();

    readonly config: SwapForGasServerConfig;

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcLnTrustedSwap>,
        path: string,
        chains: MultichainData,
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: SwapForGasServerConfig
    ) {
        super(storageDirectory, path, chains, lnd, swapPricing);
        this.config = config;
        this.config.invoiceTimeoutSeconds = this.config.invoiceTimeoutSeconds || 90;
        for(let chainId in chains.chains) {
            this.allowedTokens[chainId] = new Set<string>([chains.chains[chainId].swapContract.getNativeCurrencyAddress()]);
        }
    }

    /**
     * Unsubscribe from the pending lightning network invoice
     *
     * @param paymentHash
     * @private
     */
    private unsubscribeInvoice(paymentHash: string): boolean {
        const sub = this.activeSubscriptions.get(paymentHash);
        if(sub==null) return false;
        sub.removeAllListeners();
        this.activeSubscriptions.delete(paymentHash);
        return true;
    }

    /**
     * Subscribe to a pending lightning network invoice
     *
     * @param invoiceData
     */
    private subscribeToInvoice(invoiceData: FromBtcLnTrustedSwap) {
        const hash = invoiceData.getHash();

        //Already subscribed
        if(this.activeSubscriptions.has(invoiceData.getHash())) return;

        const sub = subscribeToInvoice({id: hash, lnd: this.LND});

        this.swapLogger.debug(invoiceData, "subscribeToInvoice(): Subscribed to invoice payment");

        sub.on('invoice_updated', (invoice: SubscribeToInvoiceInvoiceUpdatedEvent) => {
            this.swapLogger.debug(invoiceData, "subscribeToInvoice(): invoice_updated: ", invoice);
            if(!invoice.is_held) return;
            this.htlcReceived(invoiceData, invoice).catch(e => console.error(e));
            sub.removeAllListeners();
            this.activeSubscriptions.delete(hash);
        });

        this.activeSubscriptions.set(hash, sub);
    }

    /**
     *
     * @param swap
     * @protected
     * @returns {Promise<boolean>} Whether the invoice should be cancelled
     */
    protected async processPastSwap(swap: FromBtcLnTrustedSwap): Promise<boolean> {
        if(swap.state===FromBtcLnTrustedSwapState.CANCELED) return true;
        if(swap.state===FromBtcLnTrustedSwapState.REFUNDED) return true;

        const parsedPR = bolt11.decode(swap.pr);
        const invoice: GetInvoiceResult = await getInvoice({
            id: parsedPR.tagsObject.payment_hash,
            lnd: this.LND
        });

        if(invoice.is_held) {
            //Adjust the state of the swap and expiry
            try {
                await this.htlcReceived(swap, invoice);
                //Result is either FromBtcLnTrustedSwapState.RECEIVED or FromBtcLnTrustedSwapState.CANCELED
            } catch (e) {
                console.error(e);
            }
        } else if(!invoice.is_confirmed) {
            //Not paid
            const isInvoiceExpired = parsedPR.timeExpireDate<Date.now()/1000;
            if(isInvoiceExpired) {
                await swap.setState(FromBtcLnTrustedSwapState.CANCELED);
                return true;
            }
            this.subscribeToInvoice(swap);
        }

        return false;
    }

    protected async cancelInvoices(swaps: FromBtcLnTrustedSwap[]) {
        for(let swap of swaps) {
            //Cancel invoices
            try {
                const paymentHash = swap.getHash();
                await cancelHodlInvoice({
                    lnd: this.LND,
                    id: paymentHash
                });
                this.unsubscribeInvoice(paymentHash);
                this.swapLogger.info(swap, "cancelInvoices(): invoice cancelled!");
                await this.removeSwapData(swap);
            } catch (e) {
                this.swapLogger.error(swap, "cancelInvoices(): cannot cancel hodl invoice id", e);
            }
        }
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    protected async processPastSwaps(): Promise<void> {
        const cancelInvoices: FromBtcLnTrustedSwap[] = [];

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    FromBtcLnTrustedSwapState.CREATED,
                    FromBtcLnTrustedSwapState.RECEIVED,
                    FromBtcLnTrustedSwapState.SENT,
                    FromBtcLnTrustedSwapState.CONFIRMED,
                    FromBtcLnTrustedSwapState.CANCELED,
                    FromBtcLnTrustedSwapState.REFUNDED,
                ]
            }
        ]);

        for(let swap of queriedData) {
            if(await this.processPastSwap(swap)) cancelInvoices.push(swap);
        }

        await this.cancelInvoices(cancelInvoices);
    }

    private async cancelSwapAndInvoice(swap: FromBtcLnTrustedSwap): Promise<void> {
        if(swap.state!==FromBtcLnTrustedSwapState.RECEIVED) return;
        await swap.setState(FromBtcLnTrustedSwapState.CANCELED);
        const paymentHash = swap.getHash();
        await cancelHodlInvoice({
            id: paymentHash,
            lnd: this.LND
        });
        this.unsubscribeInvoice(paymentHash);
        await this.removeSwapData(swap);
        this.swapLogger.info(swap, "cancelSwapAndInvoice(): swap removed & invoice cancelled, invoice: ", swap.pr);
    }

    /**
     * Saves the state of received HTLC of the lightning payment
     *
     * @param invoiceData
     * @param invoice
     */
    private async htlcReceived(invoiceData: FromBtcLnTrustedSwap, invoice: { id: string }) {

        const {swapContract, signer} = this.getChain(invoiceData.chainIdentifier);

        //Important to prevent race condition and issuing 2 signed init messages at the same time
        if(invoiceData.state===FromBtcLnTrustedSwapState.CREATED) {
            if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcReceived = Date.now();
            await invoiceData.setState(FromBtcLnTrustedSwapState.RECEIVED);
            await this.storageManager.saveData(invoice.id, null, invoiceData);
        }

        if(invoiceData.state===FromBtcLnTrustedSwapState.RECEIVED) {
            const balance: Promise<BN> = swapContract.getBalance(signer.getAddress(), swapContract.getNativeCurrencyAddress(), false);
            try {
                await this.checkBalance(invoiceData.output, balance, null);
                if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcBalanceChecked = Date.now();
            } catch (e) {
                await this.cancelSwapAndInvoice(invoiceData);
                throw e;
            }

            if(invoiceData.state!==FromBtcLnTrustedSwapState.RECEIVED) return;

            let unlock = invoiceData.lock(30*1000);
            if(unlock==null) return;

            const txns = await swapContract.txsTransfer(signer.getAddress(), swapContract.getNativeCurrencyAddress(), invoiceData.output, invoiceData.dstAddress);
            await swapContract.sendAndConfirm(signer, txns, true, null, false, async (txId: string, rawTx: string) => {
                invoiceData.txIds = {init: txId};
                invoiceData.scRawTx = rawTx;
                if(invoiceData.state===FromBtcLnTrustedSwapState.RECEIVED) {
                    await invoiceData.setState(FromBtcLnTrustedSwapState.SENT);
                    await this.storageManager.saveData(invoice.id, null, invoiceData);
                }
                if(unlock!=null) unlock();
                unlock = null;
            });
        }

        if(invoiceData.state===FromBtcLnTrustedSwapState.SENT) {
            const txStatus = await swapContract.getTxStatus(invoiceData.scRawTx);
            if(txStatus==="not_found") {
                //Retry
                invoiceData.txIds = {init: null};
                invoiceData.scRawTx = null;
                await invoiceData.setState(FromBtcLnTrustedSwapState.RECEIVED);
                await this.storageManager.saveData(invoice.id, null, invoiceData);
            }
            if(txStatus==="reverted") {
                //Cancel invoice
                await invoiceData.setState(FromBtcLnTrustedSwapState.REFUNDED);
                await this.storageManager.saveData(invoice.id, null, invoiceData);
                await cancelHodlInvoice({
                    id: invoice.id,
                    lnd: this.LND
                });
                this.unsubscribeInvoice(invoice.id);
                await this.removeSwapData(invoice.id, null);
                this.swapLogger.info(invoiceData, "htlcReceived(): transaction reverted, refunding lightning: ", invoiceData.pr);
                throw {
                    code: 20002,
                    msg: "Transaction reverted"
                };
            }
            if(txStatus==="success") {
                //Successfully paid
                await invoiceData.setState(FromBtcLnTrustedSwapState.CONFIRMED);
                await this.storageManager.saveData(invoice.id, null, invoiceData);
            }
        }

        if(invoiceData.state===FromBtcLnTrustedSwapState.CONFIRMED) {
            await settleHodlInvoice({
                lnd: this.LND,
                secret: invoiceData.secret
            });

            if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcSettled = Date.now();

            const paymentHash = invoiceData.getHash();
            this.processedTxIds.set(paymentHash, invoiceData.txIds.init);
            await invoiceData.setState(FromBtcLnTrustedSwapState.SETTLED);

            this.unsubscribeInvoice(paymentHash);
            this.swapLogger.info(invoiceData, "htlcReceived(): invoice settled, invoice: "+invoiceData.pr+" scTxId: "+invoiceData.txIds.init);
            await this.removeSwapData(invoiceData);
        }
    }

    /**
     *
     * Checks if the lightning invoice is in HELD state (htlcs received but yet unclaimed)
     *
     * @param paymentHash
     * @throws {DefinedRuntimeError} Will throw if the lightning invoice is not found, or if it isn't in the HELD state
     * @returns the fetched lightning invoice
     */
    private async checkInvoiceStatus(paymentHash: string): Promise<GetInvoiceResult> {
        const invoice = await getInvoice({
            id: paymentHash,
            lnd: this.LND
        });

        const isInvoiceFound = invoice!=null;
        if (!isInvoiceFound) throw {
            _httpStatus: 200,
            code: 10001,
            msg: "Invoice expired/canceled"
        }

        const arr = invoice.description.split("-");
        let chainIdentifier: string;
        let address: string;
        if(arr.length>2 && arr[1]==="GAS") {
            chainIdentifier = arr[0];
            address = arr[2];
        } else {
            chainIdentifier = this.chains.default;
            address = invoice.description;
        }
        const {swapContract} = this.getChain(chainIdentifier);
        if(!swapContract.isValidAddress(address)) throw {
            _httpStatus: 200,
            code: 10001,
            msg: "Invoice expired/canceled"
        };

        const isBeingPaid = invoice.is_held;
        if (!isBeingPaid) {
            if (invoice.is_canceled) throw {
                _httpStatus: 200,
                code: 10001,
                msg: "Invoice expired/canceled"
            };
            if (invoice.is_confirmed) {
                const scTxId = this.processedTxIds.get(paymentHash);
                throw {
                    _httpStatus: 200,
                    code: 10000,
                    msg: "Invoice already paid",
                    data: {
                        txId: scTxId
                    }
                };
            }
            throw {
                _httpStatus: 200,
                code: 10010,
                msg: "Invoice yet unpaid"
            };
        }

        return invoice;
    }

    startRestServer(restServer: Express) {

        const createInvoice = expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                invoiceRequest?: any,
                invoiceResponse?: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            const chainIdentifier = req.query.chain as string ?? this.chains.default;
            const {swapContract, signer} = this.getChain(chainIdentifier);

            metadata.times.requestReceived = Date.now();
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in lamports/smart chain base units) of the invoice
             */

            const parsedBody: FromBtcLnTrustedRequestType = await req.paramReader.getParams({
                address: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    swapContract.isValidAddress(val) ? val : null,
                amount: FieldTypeEnum.BN,
                exactOut: FieldTypeEnum.BooleanOptional
            });
            if(parsedBody==null) throw {
                code: 20100,
                msg: "Invalid request body"
            };
            metadata.request = parsedBody;

            const requestedAmount = {input: !parsedBody.exactOut, amount: parsedBody.amount};
            const request = {
                chainIdentifier,
                raw: req,
                parsed: parsedBody,
                metadata
            };
            const useToken = swapContract.getNativeCurrencyAddress();

            //Check request params
            const fees = await this.preCheckAmounts(request, requestedAmount, useToken);
            metadata.times.requestChecked = Date.now();

            //Create abortController for parallel prefetches
            const responseStream = res.responseStream;
            const abortController = this.getAbortController(responseStream);

            //Pre-fetch data
            const {pricePrefetchPromise} = this.getFromBtcPricePrefetches(chainIdentifier, useToken, abortController);
            const balancePrefetch = swapContract.getBalance(signer.getAddress(), useToken, false).catch(e => {
                this.logger.error("getBalancePrefetch(): balancePrefetch error: ", e);
                abortController.abort(e);
                return null;
            });
            const channelsPrefetch: Promise<{channels: any[]}> = this.getChannelsPrefetch(abortController);

            //Check valid amount specified (min/max)
            const {
                amountBD,
                swapFee,
                swapFeeInToken,
                totalInToken
            } = await this.checkFromBtcAmount(request, requestedAmount, fees, useToken, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            //Check if we have enough funds to honor the request
            await this.checkBalance(totalInToken, balancePrefetch, abortController.signal)
            await this.checkInboundLiquidity(amountBD, channelsPrefetch, abortController.signal);
            metadata.times.balanceChecked = Date.now();

            const secret = randomBytes(32);
            const hash = createHash("sha256").update(secret).digest();
            const hodlInvoiceObj = {
                description: chainIdentifier+"-GAS-"+parsedBody.address,
                cltv_delta: this.config.minCltv.add(new BN(5)).toNumber(),
                expires_at: new Date(Date.now()+(this.config.invoiceTimeoutSeconds*1000)).toISOString(),
                id: hash.toString("hex"),
                mtokens: amountBD.mul(new BN(1000)).toString(10),
                lnd: null
            };
            metadata.invoiceRequest = {...hodlInvoiceObj};
            hodlInvoiceObj.lnd = this.LND;

            const hodlInvoice = await createHodlInvoice(hodlInvoiceObj);
            abortController.signal.throwIfAborted();
            metadata.times.invoiceCreated = Date.now();
            metadata.invoiceResponse = {...hodlInvoice};

            console.log("[From BTC-LN: REST.CreateInvoice] hodl invoice created: ", hodlInvoice);

            const createdSwap = new FromBtcLnTrustedSwap(
                chainIdentifier,
                hodlInvoice.request,
                swapFee,
                swapFeeInToken,
                totalInToken,
                secret.toString("hex"),
                parsedBody.address
            );
            metadata.times.swapCreated = Date.now();
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(hash.toString("hex"), null, createdSwap);
            this.subscribeToInvoice(createdSwap);

            this.swapLogger.info(createdSwap, "REST: /createInvoice: Created swap invoice: "+hodlInvoice.request+" amount: "+amountBD.toString(10));

            await responseStream.writeParamsAndEnd({
                msg: "Success",
                code: 10000,
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFeeInToken.toString(10),
                    total: totalInToken.toString(10),
                    intermediaryKey: signer.getAddress()
                }
            });

        });

        restServer.use(this.path+"/createInvoice", serverParamDecoder(10*1000));
        restServer.post(this.path+"/createInvoice", createInvoice);

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

            await this.checkInvoiceStatus(parsedBody.paymentHash);

            const invoiceData: FromBtcLnTrustedSwap = await this.storageManager.getData(parsedBody.paymentHash, null);
            if (invoiceData==null) throw {
                _httpStatus: 200,
                code: 10001,
                msg: "Invoice expired/canceled"
            };

            if (
                invoiceData.state === FromBtcLnTrustedSwapState.CANCELED ||
                invoiceData.state === FromBtcLnTrustedSwapState.REFUNDED
            ) throw {
                _httpStatus: 200,
                code: 10001,
                msg: "Invoice expired/canceled"
            };

            if (invoiceData.state === FromBtcLnTrustedSwapState.CREATED) throw {
                _httpStatus: 200,
                code: 10010,
                msg: "Invoice yet unpaid"
            };

            if (invoiceData.state === FromBtcLnTrustedSwapState.RECEIVED) throw {
                _httpStatus: 200,
                code: 10011,
                msg: "Invoice received, payment processing"
            };

            if (invoiceData.state === FromBtcLnTrustedSwapState.SENT) throw {
                _httpStatus: 200,
                code: 10012,
                msg: "Tx sent",
                data: {
                    txId: invoiceData.txIds.init
                }
            };

            if (invoiceData.state === FromBtcLnTrustedSwapState.CONFIRMED) throw {
                _httpStatus: 200,
                code: 10000,
                msg: "Success, tx confirmed",
                data: {
                    txId: invoiceData.txIds.init
                }
            };

            if (invoiceData.state === FromBtcLnTrustedSwapState.SETTLED) throw {
                _httpStatus: 200,
                code: 10000,
                msg: "Success, tx confirmed - invoice settled",
                data: {
                    txId: invoiceData.txIds.init
                }
            };
        });
        restServer.post(this.path+"/getInvoiceStatus", getInvoiceStatus);
        restServer.get(this.path+"/getInvoiceStatus", getInvoiceStatus);

        this.logger.info("started at path: ", this.path);
    }

    async init() {
        await this.storageManager.loadData(FromBtcLnTrustedSwap);
        await PluginManager.serviceInitialize(this);
    }

    getInfoData(): any {
        return {
            minCltv: this.config.minCltv.toNumber()
        }
    }

    protected processClaimEvent(chainIdentifier: string, event: ClaimEvent<SwapData>): Promise<void> {
        return Promise.resolve();
    }

    protected processInitializeEvent(chainIdentifier: string, event: InitializeEvent<SwapData>): Promise<void> {
        return Promise.resolve();
    }

    protected processRefundEvent(chainIdentifier: string, event: RefundEvent<SwapData>): Promise<void> {
        return Promise.resolve();
    }

}

