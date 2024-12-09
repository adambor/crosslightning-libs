import * as BN from "bn.js";
import {Express, Request, Response} from "express";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "@atomiqlabs/bolt11";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
import {MultichainData, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapData
} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {expressHandlerWrapper, HEX_REGEX, isDefinedRuntimeError} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {FromBtcBaseConfig, FromBtcBaseSwapHandler} from "../FromBtcBaseSwapHandler";
import {FromBtcLnBaseSwapHandler} from "../FromBtcLnBaseSwapHandler";

export type FromBtcLnConfig = FromBtcBaseConfig & {
    invoiceTimeoutSeconds?: number,
    minCltv: BN,
    gracePeriod: BN
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
export class FromBtcLnAbs extends FromBtcLnBaseSwapHandler<FromBtcLnSwapAbs, FromBtcLnSwapState> {

    readonly type = SwapHandlerType.FROM_BTCLN;

    readonly config: FromBtcLnConfig;

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcLnSwapAbs>,
        path: string,
        chains: MultichainData,
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcLnConfig
    ) {
        super(storageDirectory, path, chains, lnd, swapPricing);
        this.config = config;
        this.config.invoiceTimeoutSeconds = this.config.invoiceTimeoutSeconds || 90;
    }

    protected async processPastSwap(swap: FromBtcLnSwapAbs): Promise<"REFUND" | "SETTLE" | "CANCEL" | null> {
        const {swapContract} = this.getChain(swap.chainIdentifier);
        if(swap.state===FromBtcLnSwapState.CREATED) {
            //Check if already paid
            const parsedPR = bolt11.decode(swap.pr);
            const invoice = await lncli.getInvoice({
                id: parsedPR.tagsObject.payment_hash,
                lnd: this.LND
            });

            const isBeingPaid = invoice.is_held;
            if(!isBeingPaid) {
                //Not paid
                const isInvoiceExpired = parsedPR.timeExpireDate<Date.now()/1000;
                if(!isInvoiceExpired) return null;

                this.swapLogger.info(swap, "processPastSwap(state=CREATED): swap LN invoice expired, cancelling, invoice: "+swap.pr);
                await swap.setState(FromBtcLnSwapState.CANCELED);
                return "CANCEL";
            }

            //Adjust the state of the swap and expiry
            try {
                await this.htlcReceived(swap, invoice);
                //Result is either FromBtcLnSwapState.RECEIVED or FromBtcLnSwapState.CANCELED
            } catch (e) {
                this.swapLogger.error(swap, "processPastSwap(state=CREATED): htlcReceived error", e);
            }

            // @ts-ignore Previous call (htlcReceived) mutates the state of the swap, so this is valid
            if(swap.state===FromBtcLnSwapState.CANCELED) {
                this.swapLogger.info(swap, "processPastSwap(state=CREATED): invoice CANCELED after htlcReceived(), cancelling, invoice: "+swap.pr);
                return "CANCEL";
            }

            return null;
        }

        if(swap.state===FromBtcLnSwapState.RECEIVED) {
            const parsedPR = bolt11.decode(swap.pr);

            const isAuthorizationExpired = await swapContract.isInitAuthorizationExpired(swap.data, swap);
            if(isAuthorizationExpired) {
                const isCommited = await swapContract.isCommited(swap.data);

                if(!isCommited) {
                    this.swapLogger.info(swap, "processPastSwap(state=RECEIVED): swap not committed before authorization expiry, cancelling the LN invoice, invoice: "+swap.pr);
                    await swap.setState(FromBtcLnSwapState.CANCELED);
                    return "CANCEL";
                }

                this.swapLogger.info(swap, "processPastSwap(state=RECEIVED): swap committed (detected from processPastSwap), invoice: "+swap.pr);
                await swap.setState(FromBtcLnSwapState.COMMITED);
                await this.storageManager.saveData(swap.data.getHash(), null, swap);
            }
        }

        if(swap.state===FromBtcLnSwapState.RECEIVED || swap.state===FromBtcLnSwapState.COMMITED) {
            const expiryTime = swap.data.getExpiry();
            const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

            const isExpired = expiryTime!=null && expiryTime.lt(currentTime);
            if(!isExpired) return null;

            const isCommited = await swapContract.isCommited(swap.data);
            if(isCommited) {
                this.swapLogger.info(swap, "processPastSwap(state=COMMITED): swap timed out, refunding to self, invoice: "+swap.pr);
                return "REFUND";
            }

            this.swapLogger.info(swap, "processPastSwap(state=RECEIVED): swap timed out, cancelling the LN invoice, invoice: "+swap.pr);
            return "CANCEL";
        }

        if(swap.state===FromBtcLnSwapState.CLAIMED) return "SETTLE";
        if(swap.state===FromBtcLnSwapState.CANCELED) return "CANCEL";
    }

    protected async refundSwaps(refundSwaps: FromBtcLnSwapAbs[]) {
        for(let refundSwap of refundSwaps) {
            const {swapContract, signer} = this.getChain(refundSwap.chainIdentifier);
            const unlock = refundSwap.lock(swapContract.refundTimeout);
            if(unlock==null) continue;

            this.swapLogger.debug(refundSwap, "refundSwaps(): initiate refund of swap");
            await swapContract.refund(signer, refundSwap.data, true, false, {waitForConfirmation: true});
            this.swapLogger.info(refundSwap, "refundsSwaps(): swap refunded, invoice: "+refundSwap.pr);

            await refundSwap.setState(FromBtcLnSwapState.REFUNDED);
            unlock();
        }
    }

    protected async cancelInvoices(swaps: FromBtcLnSwapAbs[]) {
        for(let swap of swaps) {
            //Refund
            const paymentHash = swap.data.getHash();
            try {
                await lncli.cancelHodlInvoice({
                    lnd: this.LND,
                    id: paymentHash
                });
                this.swapLogger.info(swap, "cancelInvoices(): invoice cancelled!");
                await this.removeSwapData(swap);
            } catch (e) {
                this.swapLogger.error(swap, "cancelInvoices(): cannot cancel hodl invoice id", e);
            }
        }
    }

    protected async settleInvoices(swaps: FromBtcLnSwapAbs[]) {
        for(let swap of swaps) {
            try {
                await lncli.settleHodlInvoice({
                    lnd: this.LND,
                    secret: swap.secret
                });
                if(swap.metadata!=null) swap.metadata.times.htlcSettled = Date.now();
                await this.removeSwapData(swap, FromBtcLnSwapState.SETTLED);

                this.swapLogger.info(swap, "settleInvoices(): invoice settled, secret: "+swap.secret);
            } catch (e) {
                this.swapLogger.error(swap, "settleInvoices(): cannot settle invoice", e);
            }
        }
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    protected async processPastSwaps() {

        const settleInvoices: FromBtcLnSwapAbs[] = [];
        const cancelInvoices: FromBtcLnSwapAbs[] = [];
        const refundSwaps: FromBtcLnSwapAbs[] = [];

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
            switch(await this.processPastSwap(swap)) {
                case "CANCEL":
                    cancelInvoices.push(swap);
                    break;
                case "SETTLE":
                    settleInvoices.push(swap);
                    break;
                case "REFUND":
                    refundSwaps.push(swap);
                    break;
            }
        }

        await this.refundSwaps(refundSwaps);
        await this.cancelInvoices(cancelInvoices);
        await this.settleInvoices(settleInvoices);
    }

    protected async processInitializeEvent(chainIdentifier: string, event: InitializeEvent<SwapData>): Promise<void> {
        //Only process HTLC requests
        if (event.swapType !== ChainSwapType.HTLC) return;

        const swapData = await event.swapData();

        const {swapContract, signer} = this.getChain(chainIdentifier);
        if (!swapData.isOfferer(signer.getAddress())) return;
        if (swapData.isPayIn()) return;

        const paymentHash = event.paymentHash;

        const savedSwap = await this.storageManager.getData(paymentHash, null);
        if (savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        this.swapLogger.info(savedSwap, "SC: InitializeEvent: HTLC initialized by the client, invoice: "+savedSwap.pr);

        savedSwap.txIds.init = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();
        if(savedSwap.state===FromBtcLnSwapState.RECEIVED) {
            await savedSwap.setState(FromBtcLnSwapState.COMMITED);
            savedSwap.data = swapData;
            await this.storageManager.saveData(paymentHash, null, savedSwap);
        }
    }

    protected async processClaimEvent(chainIdentifier: string, event: ClaimEvent<SwapData>): Promise<void> {
        //Claim
        //This is the important part, we need to catch the claim TX, else we may lose money
        const secret: Buffer = Buffer.from(event.secret, "hex");
        const paymentHash: Buffer = createHash("sha256").update(secret).digest();
        const secretHex = secret.toString("hex");
        const paymentHashHex = paymentHash.toString("hex");

        const savedSwap = await this.storageManager.getData(paymentHashHex, null);
        if (savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        savedSwap.txIds.claim = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.claimTxReceived = Date.now();

        this.swapLogger.info(savedSwap, "SC: ClaimEvent: swap HTLC successfully claimed by the client, invoice: "+savedSwap.pr);

        try {
            await lncli.settleHodlInvoice({
                lnd: this.LND,
                secret: secretHex
            });
            this.swapLogger.info(savedSwap, "SC: ClaimEvent: invoice settled, secret: "+secretHex);
            savedSwap.secret = secretHex;
            if(savedSwap.metadata!=null) savedSwap.metadata.times.htlcSettled = Date.now();
            await this.removeSwapData(savedSwap, FromBtcLnSwapState.SETTLED);
        } catch (e) {
            this.swapLogger.error(savedSwap, "SC: ClaimEvent: cannot settle invoice", e);
            savedSwap.secret = secretHex;
            await savedSwap.setState(FromBtcLnSwapState.CLAIMED);
            await this.storageManager.saveData(paymentHashHex, null, savedSwap);
        }

    }

    protected async processRefundEvent(chainIdentifier: string, event: RefundEvent<SwapData>): Promise<void> {
        //Refund
        //Try to get the hash from the refundMap
        if (event.paymentHash == null) return;

        const savedSwap = await this.storageManager.getData(event.paymentHash, null);
        if (savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        savedSwap.txIds.refund = (event as any).meta?.txId;

        this.swapLogger.info(savedSwap, "SC: RefundEvent: swap refunded to us, invoice: "+savedSwap.pr);

        try {
            await lncli.cancelHodlInvoice({
                lnd: this.LND,
                id: event.paymentHash
            });
            this.swapLogger.info(savedSwap, "SC: RefundEvent: invoice cancelled");
            await this.removeSwapData(savedSwap, FromBtcLnSwapState.REFUNDED);
        } catch (e) {
            this.swapLogger.error(savedSwap, "SC: RefundEvent: cannot cancel invoice", e);
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
    private async htlcReceived(invoiceData: FromBtcLnSwapAbs, invoice: any) {
        this.swapLogger.debug(invoiceData, "htlcReceived(): invoice: ", invoice);
        if(invoiceData.metadata!=null) invoiceData.metadata.times.htlcReceived = Date.now();

        const useToken = invoiceData.data.getToken();
        const sendAmount: BN = invoiceData.data.getAmount();

        //Create abort controller for parallel fetches
        const abortController = new AbortController();

        //Pre-fetch data
        const balancePrefetch: Promise<BN> = this.getBalancePrefetch(invoiceData.chainIdentifier, useToken, abortController);
        const blockheightPrefetch = this.getBlockheightPrefetch(abortController);
        const signDataPrefetchPromise: Promise<any> = this.getSignDataPrefetch(invoiceData.chainIdentifier, abortController);

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

        const {swapContract, signer} = this.getChain(invoiceData.chainIdentifier);

        //Create real swap data
        const payInvoiceObject: SwapData = await swapContract.createSwapData(
            ChainSwapType.HTLC,
            signer.getAddress(),
            invoiceData.data.getClaimer(),
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
        const sigData = await swapContract.getInitSignature(
            signer,
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
    private checkDescriptionHash(descriptionHash: string) {
        if(descriptionHash!=null) {
            if(typeof(descriptionHash)!=="string" || !HEX_REGEX.test(descriptionHash) || descriptionHash.length!==64) {
                throw {
                    code: 20100,
                    msg: "Invalid request body (descriptionHash)"
                };
            }
        }
    }

    /**
     * Starts LN channels pre-fetch
     *
     * @param abortController
     */
    private getBlockheightPrefetch(abortController: AbortController): Promise<number> {
        return lncli.getHeight({lnd: this.LND}).then(res => res.current_block_height).catch(e => {
            this.logger.error("getBlockheightPrefetch(): error", e);
            abortController.abort(e);
            return null;
        });
    }

    /**
     * Asynchronously sends the LN node's public key to the client, so he can pre-fetch the node's channels from 1ml api
     *
     * @param responseStream
     */
    private sendPublicKeyAsync(responseStream: ServerParamEncoder) {
        lncli.getWalletInfo({lnd: this.LND}).then(resp => responseStream.writeParams({
            lnPublicKey: resp.public_key
        })).catch(e => {
            this.logger.error("sendPublicKeyAsync(): error", e);
        });
    }

    /**
     * Returns the CLTV timeout (blockheight) of the received HTLC corresponding to the invoice. If multiple HTLCs are
     *  received (MPP) it returns the lowest of the timeouts
     *
     * @param invoice
     */
    private getInvoicePaymentsTimeout(invoice: {payments: {timeout: number}[]}) {
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
    private async checkHtlcExpiry(invoice: {payments: {timeout: number}[]}, blockheightPrefetch: Promise<number>, signal: AbortSignal): Promise<BN> {
        const timeout: number = this.getInvoicePaymentsTimeout(invoice);
        const current_block_height = await blockheightPrefetch;
        signal.throwIfAborted();

        const blockDelta = new BN(timeout - current_block_height);

        const htlcExpiresTooSoon = blockDelta.lt(this.config.minCltv);
        if(htlcExpiresTooSoon) {
            throw {
                code: 20002,
                msg: "Not enough time to reliably process the swap",
                data: {
                    requiredDelta: this.config.minCltv.toString(10),
                    actualDelta: blockDelta.toString(10)
                }
            };
        }

        return this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);
    }

    /**
     * Cancels the swap (CANCELED state) & also cancels the LN invoice (including all pending HTLCs)
     *
     * @param invoiceData
     */
    private async cancelSwapAndInvoice(invoiceData: FromBtcLnSwapAbs): Promise<void> {
        if(invoiceData.state!==FromBtcLnSwapState.CREATED) return;
        await invoiceData.setState(FromBtcLnSwapState.CANCELED);
        const paymentHash = invoiceData.data.getHash();
        await lncli.cancelHodlInvoice({
            id: paymentHash,
            lnd: this.LND
        });
        await this.removeSwapData(invoiceData);
        this.swapLogger.info(invoiceData, "cancelSwapAndInvoice(): swap removed & invoice cancelled, invoice: ", invoiceData.pr);
    };

    private getDummySwapData(chainIdentifier: string, useToken: string, address: string, paymentHash: string) {
        const {swapContract, signer} = this.getChain(chainIdentifier);
        return swapContract.createSwapData(
            ChainSwapType.HTLC,
            signer.getAddress(),
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

    /**
     *
     * Checks if the lightning invoice is in HELD state (htlcs received but yet unclaimed)
     *
     * @param paymentHash
     * @throws {DefinedRuntimeError} Will throw if the lightning invoice is not found, or if it isn't in the HELD state
     * @returns the fetched lightning invoice
     */
    private async checkInvoiceStatus(paymentHash: string): Promise<any> {
        const invoice = await lncli.getInvoice({
            id: paymentHash,
            lnd: this.LND
        });
        if(invoice==null) throw {
            _httpStatus: 200,
            code: 10001,
            msg: "Invoice expired/canceled"
        };

        const arr = invoice.description.split("-");
        let chainIdentifier: string;
        let address: string;
        if(arr.length>1) {
            chainIdentifier = arr[0];
            address = arr[1];
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
            }
            if (invoice.is_confirmed) throw {
                _httpStatus: 200,
                code: 10002,
                msg: "Invoice already paid"
            };
            throw {
                _httpStatus: 200,
                code: 10003,
                msg: "Invoice yet unpaid"
            };
        }

        return invoice;
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

            const chainIdentifier = req.query.chain as string ?? this.chains.default;
            const {swapContract, signer} = this.getChain(chainIdentifier);

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
                            swapContract.isValidAddress(val) ? val : null,
                paymentHash: (val: string) => val!=null &&
                            typeof(val)==="string" &&
                            val.length===64 &&
                            HEX_REGEX.test(val) ? val: null,
                amount: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.isTokenSupported(chainIdentifier, val) ? val : null,
                descriptionHash: FieldTypeEnum.StringOptional,
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
            const useToken = parsedBody.token;

            //Check request params
            this.checkDescriptionHash(parsedBody.descriptionHash);
            const fees = await this.preCheckAmounts(request, requestedAmount, useToken);
            metadata.times.requestChecked = Date.now();

            //Create abortController for parallel prefetches
            const responseStream = res.responseStream;
            const abortController = this.getAbortController(responseStream);

            //Pre-fetch data
            const {pricePrefetchPromise, securityDepositPricePrefetchPromise} = this.getFromBtcPricePrefetches(chainIdentifier, useToken, abortController);
            const balancePrefetch: Promise<BN> = this.getBalancePrefetch(chainIdentifier, useToken, abortController);
            const channelsPrefetch: Promise<{channels: any[]}> = this.getChannelsPrefetch(abortController);

            const dummySwapData = await this.getDummySwapData(chainIdentifier, useToken, parsedBody.address, parsedBody.paymentHash);
            abortController.signal.throwIfAborted();
            const baseSDPromise: Promise<BN> = this.getBaseSecurityDepositPrefetch(chainIdentifier, dummySwapData, abortController);

            //Asynchronously send the node's public key to the client
            this.sendPublicKeyAsync(responseStream);

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

            //Create swap
            const hodlInvoiceObj: any = {
                description: chainIdentifier+"-"+parsedBody.address,
                cltv_delta: this.config.minCltv.add(new BN(5)).toString(10),
                expires_at: new Date(Date.now()+(this.config.invoiceTimeoutSeconds*1000)).toISOString(),
                id: parsedBody.paymentHash,
                tokens: amountBD.toString(10),
                description_hash: parsedBody.descriptionHash
            };
            metadata.invoiceRequest = {...hodlInvoiceObj};
            hodlInvoiceObj.lnd = this.LND;

            const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);
            abortController.signal.throwIfAborted();
            metadata.times.invoiceCreated = Date.now();
            metadata.invoiceResponse = {...hodlInvoice};

            const createdSwap = new FromBtcLnSwapAbs(chainIdentifier, hodlInvoice.request, swapFee, swapFeeInToken);

            //Pre-compute the security deposit
            const expiryTimeout = this.config.minCltv.mul(this.config.bitcoinBlocktime.div(this.config.safetyFactor)).sub(this.config.gracePeriod);
            const totalSecurityDeposit = await this.getSecurityDeposit(
                chainIdentifier, amountBD, swapFee, expiryTimeout,
                baseSDPromise, securityDepositPricePrefetchPromise,
                abortController.signal, metadata
            );
            metadata.times.securityDepositCalculated = Date.now();

            //Create swap data
            createdSwap.data = await swapContract.createSwapData(
                ChainSwapType.HTLC,
                signer.getAddress(),
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

            this.swapLogger.info(createdSwap, "REST: /createInvoice: Created swap invoice: "+hodlInvoice.request+" amount: "+amountBD.toString(10));

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFeeInToken.toString(10),
                    total: totalInToken.toString(10),
                    intermediaryKey: signer.getAddress(),
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

            await this.checkInvoiceStatus(parsedBody.paymentHash);

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

            const invoice: any =  await this.checkInvoiceStatus(parsedBody.paymentHash);

            const swap: FromBtcLnSwapAbs = await this.storageManager.getData(parsedBody.paymentHash, null);
            if (swap==null) throw {
                _httpStatus: 200,
                code: 10001,
                msg: "Invoice expired/canceled"
            };

            const {swapContract, signer} = this.getChain(swap.chainIdentifier);

            if (swap.state === FromBtcLnSwapState.RECEIVED) {
                if (await swapContract.isInitAuthorizationExpired(swap.data, swap)) throw {
                    _httpStatus: 200,
                    code: 10001,
                    msg: "Invoice expired/canceled"
                }
            }

            if (swap.state === FromBtcLnSwapState.CREATED) {
                try {
                    await this.htlcReceived(swap, invoice);
                } catch (e) {
                    if(isDefinedRuntimeError(e)) e._httpStatus = 200;
                    throw e;
                }
                this.swapLogger.info(swap, "REST: /getInvoicePaymentAuth: swap processed through htlcReceived, invoice: "+swap.pr);
            }

            if (swap.state === FromBtcLnSwapState.CANCELED) throw {
                _httpStatus: 200,
                code: 10001,
                msg: "Invoice expired/canceled"
            };

            if (swap.state === FromBtcLnSwapState.COMMITED) throw {
                _httpStatus: 200,
                code: 10004,
                msg: "Invoice already committed"
            };

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    address: signer.getAddress(),
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

        this.logger.info("started at path: ", this.path);
    }

    async init() {
        await this.storageManager.loadData(FromBtcLnSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    getInfoData(): any {
        return {
            minCltv: this.config.minCltv.toNumber()
        };
    }

}

