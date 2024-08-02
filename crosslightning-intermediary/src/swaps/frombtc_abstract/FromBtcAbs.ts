import * as BN from "bn.js";
import * as lncli from "ln-service";
import {Express} from "express";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
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
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto";
import {expressHandlerWrapper} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {FieldTypeEnum} from "../../utils/paramcoders/SchemaVerifier";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {FromBtcBaseConfig, FromBtcBaseSwapHandler} from "../FromBtcBaseSwapHandler";

export type FromBtcConfig = FromBtcBaseConfig & {
    bitcoinNetwork: bitcoin.networks.Network
    confirmations: number,
    swapCsvDelta: number
};

export type FromBtcRequestType = {
    address: string,
    amount: BN,
    token: string,
    sequence: BN,
    exactOut?: boolean
};

/**
 * Swap handler handling from BTC swaps using PTLCs (proof-time locked contracts) and btc relay (on-chain bitcoin SPV)
 */
export class FromBtcAbs<T extends SwapData> extends FromBtcBaseSwapHandler<FromBtcSwapAbs<T>, T, FromBtcSwapState> {

    readonly type = SwapHandlerType.FROM_BTC;

    readonly config: FromBtcConfig & {swapTsCsvDelta: BN};

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, allowedTokens, lnd, swapPricing);
        const anyConfig = config as any;
        anyConfig.swapTsCsvDelta = new BN(config.swapCsvDelta).mul(config.bitcoinBlocktime.div(config.safetyFactor));
        this.config = anyConfig;
    }

    /**
     * Returns the TXO hash of the specific address and amount - sha256(u64le(amount) + outputScript(address))
     *
     * @param address
     * @param amount
     * @param bitcoinNetwork
     */
    private getTxoHash(address: string, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    /**
     * Returns the payment hash of the swap, takes swap nonce into account. Payment hash is chain-specific.
     *
     * @param address
     * @param amount
     */
    private getHash(address: string, amount: BN): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, this.config.bitcoinNetwork);
        return this.swapContract.getHashForOnchain(parsedOutputScript, amount, new BN(0));
    }

    /**
     * Returns TXO hash of the swap (hash without using payment nonce)
     *
     * @param swap
     */
    private getChainTxoHash(swap: FromBtcSwapAbs<T>): Buffer {
        return this.getTxoHash(swap.address, swap.amount, this.config.bitcoinNetwork);
    }

    /**
     * Processes past swap
     *
     * @param swap
     * @protected
     * @returns true if the swap should be refunded, false if nothing should be done
     */
    protected async processPastSwap(swap: FromBtcSwapAbs<T>): Promise<boolean> {
        //Current time, minus maximum chain time skew
        const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

        //Once authorization expires in CREATED state, the user can no more commit it on-chain
        if(swap.state===FromBtcSwapState.CREATED) {
            const isExpired = swap.authorizationExpiry.lt(currentTime);
            if(!isExpired) return false;

            const isCommited = await this.swapContract.isCommited(swap.data);
            if(isCommited) {
                this.logger.info("processPastSwap(state=CREATED): swap was commited, but processed from watchdog, payment hash: "+swap.getHash()+" address: "+swap.address);
                await swap.setState(FromBtcSwapState.COMMITED);
                await this.storageManager.saveData(swap.getHash(), swap.getSequence(), swap);
                return false;
            }

            this.logger.info("processPastSwap(state=CREATED): removing past swap due to authorization expiry, payment hash: "+swap.getHash()+" address: "+swap.address);
            await this.removeSwapData(swap, FromBtcSwapState.CANCELED);
            return false;
        }

        const expiryTime = swap.data.getExpiry();
        //Check if commited swap expired by now
        if(swap.state===FromBtcSwapState.COMMITED) {
            const isExpired = expiryTime.lt(currentTime);
            if(!isExpired) return false;

            const isCommited = await this.swapContract.isCommited(swap.data);
            if(isCommited) {
                this.logger.info("processPastSwap(state=COMMITED): swap expired, will refund, payment hash: "+swap.getHash()+" address: "+swap.address);
                return true;
            }

            this.logger.warn("processPastSwap(state=COMMITED): commited swap expired and not committed anymore (already refunded?), payment hash: "+swap.getHash()+" address: "+swap.address);
            await this.removeSwapData(swap, FromBtcSwapState.CANCELED);
            return false;
        }
    }

    /**
     * Checks past swaps, refunds and deletes ones that are already expired.
     */
    protected async processPastSwaps() {

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    FromBtcSwapState.CREATED,
                    FromBtcSwapState.COMMITED
                ]
            }
        ]);

        const refundSwaps: FromBtcSwapAbs<T>[] = [];

        for(let swap of queriedData) {
            if(await this.processPastSwap(swap)) refundSwaps.push(swap);
        }

        await this.refundSwaps(refundSwaps);
    }

    /**
     * Refunds all swaps (calls SC on-chain refund function)
     *
     * @param refundSwaps
     * @protected
     */
    protected async refundSwaps(refundSwaps: FromBtcSwapAbs<T>[]) {
        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;
            this.logger.debug("refundSwaps(): initiate refund of swap payment hash: "+refundSwap.getHash());
            await this.swapContract.refund(refundSwap.data, true, false, true);
            this.logger.info("refundSwaps(): swap refunded: "+refundSwap.getHash()+" address: "+refundSwap.address);
            //The swap should be removed by the event handler
            await refundSwap.setState(FromBtcSwapState.REFUNDED);
            unlock();
        }
    }

    protected async processInitializeEvent(event: InitializeEvent<T>) {
        this.logger.debug("SC: InitializeEvent: payment hash: "+event.paymentHash+" sequence: "+event.sequence.toString(16)+" swap type: "+event.swapType);
        //Only process on-chain requests
        if (event.swapType !== ChainSwapType.CHAIN) return;

        const swapData = await event.swapData();

        if (!this.swapContract.areWeOfferer(swapData)) return;
        //Only process requests that don't pay in from the program
        if (swapData.isPayIn()) return;

        const paymentHash = event.paymentHash;
        const savedSwap = await this.storageManager.getData(paymentHash, event.sequence);
        if(savedSwap==null) return;

        savedSwap.txIds.init = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();

        this.logger.info("SC: InitializeEvent: swap initialized by the client, payment hash: "+event.paymentHash+" address: "+savedSwap.address);

        if(savedSwap.state===FromBtcSwapState.CREATED) {
            await savedSwap.setState(FromBtcSwapState.COMMITED);
            savedSwap.data = swapData;
            await this.storageManager.saveData(paymentHash, event.sequence, savedSwap);
        }
    }

    protected async processClaimEvent(event: ClaimEvent<T>): Promise<void> {
        this.logger.debug("SC: ClaimEvent: payment hash: "+event.paymentHash+" sequence: "+event.sequence.toString(16)+" secret: "+event.secret);
        const paymentHashHex = event.paymentHash;

        const savedSwap = await this.storageManager.getData(paymentHashHex, event.sequence);
        if (savedSwap == null) return;

        savedSwap.txId = Buffer.from(event.secret, "hex").reverse().toString("hex");
        savedSwap.txIds.claim = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.claimTxReceived = Date.now();

        this.logger.info("SC: ClaimEvent: swap successfully claimed by the client, payment hash: "+event.paymentHash+" address: "+savedSwap.address);
        await this.removeSwapData(savedSwap, FromBtcSwapState.CLAIMED);
    }

    protected async processRefundEvent(event: RefundEvent<T>) {
        this.logger.debug("SC: RefundEvent: payment hash: "+event.paymentHash+" sequence: "+event.sequence.toString(16));
        if (event.paymentHash == null) return;

        const savedSwap = await this.storageManager.getData(event.paymentHash, event.sequence);
        if(savedSwap == null) return;

        savedSwap.txIds.refund = (event as any).meta?.txId;

        this.logger.info("SC: RefundEvent: swap refunded by the client, payment hash: "+event.paymentHash+" address: "+savedSwap.address);
        await this.removeSwapData(savedSwap, FromBtcSwapState.REFUNDED);
    }

    /**
     * Checks if sequence number is in valid range (0-2^64)
     *
     * @param sequence
     * @throws {DefinedRuntimeError} will throw an error if the sequence number is out of bounds
     */
    checkSequence(sequence: BN): void {
        if(sequence.isNeg() || sequence.gte(new BN(2).pow(new BN(64)))) {
            throw {
                code: 20042,
                msg: "Invalid sequence"
            };
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
    async checkPlugins(req: Request & {paramReader: IParamReader}, parsedBody: FromBtcRequestType, metadata: any): Promise<{baseFee: BN, feePPM: BN}> {
        const pluginResult = await PluginManager.onSwapRequestFromBtc(req, parsedBody, metadata);

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
     * Calculates the requested claimer bounty, based on client's request
     *
     * @param req
     * @param expiry
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if the plugin cancelled the request
     * @returns {Promise<BN>} resulting claimer bounty to be used with the swap
     */
    async getClaimerBounty(req: Request & {paramReader: IParamReader}, expiry: BN, signal: AbortSignal): Promise<BN> {
        const parsedClaimerBounty = await req.paramReader.getParams({
            claimerBounty: {
                feePerBlock: FieldTypeEnum.BN,
                safetyFactor: FieldTypeEnum.BN,
                startTimestamp: FieldTypeEnum.BN,
                addBlock: FieldTypeEnum.BN,
                addFee: FieldTypeEnum.BN,
            },
        }).catch(e => null);

        signal.throwIfAborted();

        if(parsedClaimerBounty==null || parsedClaimerBounty.claimerBounty==null) {
            throw {
                code: 20043,
                msg: "Invalid claimerBounty"
            };
        }

        const tsDelta = expiry.sub(parsedClaimerBounty.claimerBounty.startTimestamp);
        const blocksDelta = tsDelta.div(this.config.bitcoinBlocktime).mul(parsedClaimerBounty.claimerBounty.safetyFactor);
        const totalBlock = blocksDelta.add(parsedClaimerBounty.claimerBounty.addBlock);
        return parsedClaimerBounty.claimerBounty.addFee.add(totalBlock.mul(parsedClaimerBounty.claimerBounty.feePerBlock));
    }

    getDummySwapData(useToken: TokenAddress, address: string): Promise<T> {
        return this.swapContract.createSwapData(
            ChainSwapType.CHAIN,
            this.swapContract.getAddress(),
            address,
            useToken,
            null,
            null,
            null,
            null,
            new BN(0),
            this.config.confirmations,
            false,
            true,
            null,
            null
        );
    }

    /**
     * Sets up required listeners for the REST server
     *
     * @param restServer
     */
    startRestServer(restServer: Express) {

        restServer.use(this.path+"/getAddress", serverParamDecoder(10*1000));
        restServer.post(this.path+"/getAddress", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to use
             * exactOut: boolean             Whether the swap should be an exact out instead of exact in swap
             * sequence: BN                 Unique sequence number for the swap
             *
             *Sent later
             * claimerBounty: object        Data for calculating claimer bounty
             *  - feePerBlock: string           Fee per block to be synchronized with btc relay
             *  - safetyFactor: number          Safety factor to multiply required blocks (when using 10 min block time)
             *  - startTimestamp: string        UNIX seconds used for timestamp delta calc
             *  - addBlock: number              Additional blocks to add to the calculation
             *  - addFee: string                Additional fee to add to the final claimer bounty
             * feeRate: string              Fee rate to be used for init signature
             */
            const parsedBody: FromBtcRequestType = await req.paramReader.getParams({
                address: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.swapContract.isValidAddress(val) ? val : null,
                amount: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                sequence: FieldTypeEnum.BN,
                exactOut: FieldTypeEnum.BooleanOptional
            });
            if(parsedBody==null) throw {
                code: 20100,
                msg: "Invalid request body"
            };
            metadata.request = parsedBody;

            //Check request params
            this.checkSequence(parsedBody.sequence);
            const {baseFee, feePPM} = await this.checkPlugins(req, parsedBody, metadata);
            metadata.times.requestChecked = Date.now();

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            //Create abortController for parallel prefetches
            const responseStream = res.responseStream;
            const abortController = this.getAbortController(responseStream);

            //Pre-fetch data
            const {pricePrefetchPromise, securityDepositPricePrefetchPromise} = this.getFromBtcPricePrefetches(useToken, abortController);
            const balancePrefetch: Promise<BN> = this.getBalancePrefetch(useToken, abortController);
            const signDataPrefetchPromise: Promise<any> = this.getSignDataPrefetch(abortController, responseStream);

            const dummySwapData = await this.getDummySwapData(useToken, parsedBody.address);
            abortController.signal.throwIfAborted();
            const baseSDPromise: Promise<BN> = this.getBaseSecurityDepositPrefetch(dummySwapData, abortController);

            //Check valid amount specified (min/max)
            const {
                amountBD,
                swapFee,
                swapFeeInToken,
                totalInToken
            } = await this.checkFromBtcAmount(parsedBody.exactOut, parsedBody.amount, useToken, {baseFee, feePPM}, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            //Check if we have enough funds to honor the request
            await this.checkBalance(totalInToken, balancePrefetch, abortController.signal);
            metadata.times.balanceChecked = Date.now();

            //Create swap
            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: this.LND,
                format: "p2wpkh"
            });
            abortController.signal.throwIfAborted();
            metadata.times.addressCreated = Date.now();

            const paymentHash = this.getHash(receiveAddress, amountBD);
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = this.config.swapTsCsvDelta;
            const expiry = currentTimestamp.add(expiryTimeout);

            //Calculate security deposit
            const totalSecurityDeposit = await this.getSecurityDeposit(
                amountBD, swapFee, expiryTimeout,
                baseSDPromise, securityDepositPricePrefetchPromise,
                abortController.signal, metadata
            );
            metadata.times.securityDepositCalculated = Date.now();

            //Calculate claimer bounty
            const totalClaimerBounty = await this.getClaimerBounty(req, expiry, abortController.signal);
            metadata.times.claimerBountyCalculated = Date.now();

            //Create swap data
            const data: T = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN,
                this.swapContract.getAddress(),
                parsedBody.address,
                useToken,
                totalInToken,
                paymentHash.toString("hex"),
                parsedBody.sequence,
                expiry,
                new BN(0),
                this.config.confirmations,
                false,
                true,
                totalSecurityDeposit,
                totalClaimerBounty
            );
            abortController.signal.throwIfAborted();
            metadata.times.swapCreated = Date.now();

            //Sign the swap
            const sigData = await this.getFromBtcSignatureData(data, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap: FromBtcSwapAbs<T> = new FromBtcSwapAbs<T>(receiveAddress, amountBD, swapFee);
            data.setTxoHash(this.getChainTxoHash(createdSwap).toString("hex"));
            createdSwap.data = data;
            createdSwap.metadata = metadata;
            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(createdSwap.data.getHash(), createdSwap.data.getSequence(), createdSwap);

            this.logger.info("REST: getAddress: Created swap address: "+receiveAddress+" amount: "+amountBD.toString(10)+" payment hash: "+createdSwap.getHash());

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    btcAddress: receiveAddress,
                    address: this.swapContract.getAddress(),
                    swapFee: swapFeeInToken.toString(10),
                    total: totalInToken.toString(10),
                    data: data.serialize(),
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        }));

        this.logger.info("REST: Started at path: ", this.path);
    }

    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    async init() {
        await this.storageManager.loadData(FromBtcSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    /**
     * Returns swap handler info
     */
    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any, tokens: string[] } {
        return {
            swapFeePPM: this.config.feePPM.toNumber(),
            swapBaseFee: this.config.baseFee.toNumber(),
            min: this.config.min.toNumber(),
            max: this.config.max.toNumber(),
            data: {
                confirmations: this.config.confirmations,

                cltv: this.config.swapCsvDelta,
                timestampCltv: this.config.swapTsCsvDelta.toNumber()
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }
}
