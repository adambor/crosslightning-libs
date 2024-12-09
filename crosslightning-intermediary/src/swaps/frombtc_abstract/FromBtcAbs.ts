import * as BN from "bn.js";
import * as lncli from "ln-service";
import {Express, Request, Response} from "express";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
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
export class FromBtcAbs extends FromBtcBaseSwapHandler<FromBtcSwapAbs, FromBtcSwapState> {

    readonly type = SwapHandlerType.FROM_BTC;

    readonly config: FromBtcConfig & {swapTsCsvDelta: BN};

    constructor(
        storageDirectory: IIntermediaryStorage<FromBtcSwapAbs>,
        path: string,
        chains: MultichainData,
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcConfig
    ) {
        super(storageDirectory, path, chains, lnd, swapPricing);
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
     * @param chainIdentifier
     * @param address
     * @param amount
     */
    private getHash(chainIdentifier: string, address: string, amount: BN): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, this.config.bitcoinNetwork);
        const {swapContract} = this.getChain(chainIdentifier);
        return swapContract.getHashForOnchain(parsedOutputScript, amount, new BN(0));
    }

    /**
     * Processes past swap
     *
     * @param swap
     * @protected
     * @returns true if the swap should be refunded, false if nothing should be done
     */
    protected async processPastSwap(swap: FromBtcSwapAbs): Promise<boolean> {
        //Current time, minus maximum chain time skew
        const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

        const {swapContract} = this.getChain(swap.chainIdentifier);

        //Once authorization expires in CREATED state, the user can no more commit it on-chain
        if(swap.state===FromBtcSwapState.CREATED) {
            const isExpired = swap.authorizationExpiry.lt(currentTime);
            if(!isExpired) return false;

            const isCommited = await swapContract.isCommited(swap.data);
            if(isCommited) {
                this.swapLogger.info(swap, "processPastSwap(state=CREATED): swap was commited, but processed from watchdog, address: "+swap.address);
                await swap.setState(FromBtcSwapState.COMMITED);
                await this.storageManager.saveData(swap.getHash(), swap.getSequence(), swap);
                return false;
            }

            this.swapLogger.info(swap, "processPastSwap(state=CREATED): removing past swap due to authorization expiry, address: "+swap.address);
            await this.removeSwapData(swap, FromBtcSwapState.CANCELED);
            return false;
        }

        const expiryTime = swap.data.getExpiry();
        //Check if commited swap expired by now
        if(swap.state===FromBtcSwapState.COMMITED) {
            const isExpired = expiryTime.lt(currentTime);
            if(!isExpired) return false;

            const isCommited = await swapContract.isCommited(swap.data);
            if(isCommited) {
                this.swapLogger.info(swap, "processPastSwap(state=COMMITED): swap expired, will refund, address: "+swap.address);
                return true;
            }

            this.swapLogger.warn(swap, "processPastSwap(state=COMMITED): commited swap expired and not committed anymore (already refunded?), address: "+swap.address);
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

        const refundSwaps: FromBtcSwapAbs[] = [];

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
    protected async refundSwaps(refundSwaps: FromBtcSwapAbs[]) {
        for(let refundSwap of refundSwaps) {
            const {swapContract, signer} = this.getChain(refundSwap.chainIdentifier);
            const unlock = refundSwap.lock(swapContract.refundTimeout);
            if(unlock==null) continue;
            this.swapLogger.debug(refundSwap, "refundSwaps(): initiate refund of swap");
            await swapContract.refund(signer, refundSwap.data, true, false, {waitForConfirmation: true});
            this.swapLogger.info(refundSwap, "refundSwaps(): swap refunded, address: "+refundSwap.address);
            //The swap should be removed by the event handler
            await refundSwap.setState(FromBtcSwapState.REFUNDED);
            unlock();
        }
    }

    protected async processInitializeEvent(chainIdentifier: string, event: InitializeEvent<SwapData>) {
        //Only process on-chain requests
        if (event.swapType !== ChainSwapType.CHAIN) return;

        const swapData = await event.swapData();

        const {signer} = this.getChain(chainIdentifier);

        if (!swapData.isOfferer(signer.getAddress())) return;
        //Only process requests that don't pay in from the program
        if (swapData.isPayIn()) return;

        const paymentHash = event.paymentHash;
        const savedSwap = await this.storageManager.getData(paymentHash, event.sequence);
        if(savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        savedSwap.txIds.init = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.initTxReceived = Date.now();

        this.swapLogger.info(savedSwap, "SC: InitializeEvent: swap initialized by the client, address: "+savedSwap.address);

        if(savedSwap.state===FromBtcSwapState.CREATED) {
            await savedSwap.setState(FromBtcSwapState.COMMITED);
            savedSwap.data = swapData;
            await this.storageManager.saveData(paymentHash, event.sequence, savedSwap);
        }
    }

    protected async processClaimEvent(chainIdentifier: string, event: ClaimEvent<SwapData>): Promise<void> {
        const paymentHashHex = event.paymentHash;

        const savedSwap = await this.storageManager.getData(paymentHashHex, event.sequence);
        if(savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        savedSwap.txId = Buffer.from(event.secret, "hex").reverse().toString("hex");
        savedSwap.txIds.claim = (event as any).meta?.txId;
        if(savedSwap.metadata!=null) savedSwap.metadata.times.claimTxReceived = Date.now();

        this.swapLogger.info(savedSwap, "SC: ClaimEvent: swap successfully claimed by the client, address: "+savedSwap.address);
        await this.removeSwapData(savedSwap, FromBtcSwapState.CLAIMED);
    }

    protected async processRefundEvent(chainIdentifier: string, event: RefundEvent<SwapData>) {
        if (event.paymentHash == null) return;

        const savedSwap = await this.storageManager.getData(event.paymentHash, event.sequence);
        if(savedSwap==null || savedSwap.chainIdentifier!==chainIdentifier) return;

        savedSwap.txIds.refund = (event as any).meta?.txId;

        this.swapLogger.info(event, "SC: RefundEvent: swap refunded, address: "+savedSwap.address);
        await this.removeSwapData(savedSwap, FromBtcSwapState.REFUNDED);
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
    private async getClaimerBounty(req: Request & {paramReader: IParamReader}, expiry: BN, signal: AbortSignal): Promise<BN> {
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

    private getDummySwapData(chainIdentifier: string, useToken: string, address: string): Promise<SwapData> {
        const {swapContract, signer} = this.getChain(chainIdentifier);
        return swapContract.createSwapData(
            ChainSwapType.CHAIN,
            signer.getAddress(),
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
                times: {[key: string]: number},
            } = {request: {}, times: {}};

            const chainIdentifier = req.query.chain as string ?? this.chains.default;
            const {swapContract, signer} = this.getChain(chainIdentifier);

            metadata.times.requestReceived = Date.now();
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to use
             * exactOut: boolean            Whether the swap should be an exact out instead of exact in swap
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
                        swapContract.isValidAddress(val) ? val : null,
                amount: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.isTokenSupported(chainIdentifier, val) ? val : null,
                sequence: FieldTypeEnum.BN,
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
            this.checkSequence(parsedBody.sequence);
            const fees = await this.preCheckAmounts(request, requestedAmount, useToken);
            metadata.times.requestChecked = Date.now();

            //Create abortController for parallel prefetches
            const responseStream = res.responseStream;
            const abortController = this.getAbortController(responseStream);

            //Pre-fetch data
            const {pricePrefetchPromise, securityDepositPricePrefetchPromise} = this.getFromBtcPricePrefetches(chainIdentifier, useToken, abortController);
            const balancePrefetch: Promise<BN> = this.getBalancePrefetch(chainIdentifier, useToken, abortController);
            const signDataPrefetchPromise: Promise<any> = this.getSignDataPrefetch(chainIdentifier, abortController, responseStream);

            const dummySwapData = await this.getDummySwapData(chainIdentifier, useToken, parsedBody.address);
            abortController.signal.throwIfAborted();
            const baseSDPromise: Promise<BN> = this.getBaseSecurityDepositPrefetch(chainIdentifier, dummySwapData, abortController);

            //Check valid amount specified (min/max)
            const {
                amountBD,
                swapFee,
                swapFeeInToken,
                totalInToken
            } = await this.checkFromBtcAmount(request, requestedAmount, fees, useToken, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            //Check if we have enough funds to honor the request
            await this.checkBalance(totalInToken, balancePrefetch, abortController.signal);
            metadata.times.balanceChecked = Date.now();

            //Create swap receive bitcoin address
            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: this.LND,
                format: "p2wpkh"
            });
            abortController.signal.throwIfAborted();
            metadata.times.addressCreated = Date.now();

            const paymentHash = this.getHash(chainIdentifier, receiveAddress, amountBD);
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = this.config.swapTsCsvDelta;
            const expiry = currentTimestamp.add(expiryTimeout);

            //Calculate security deposit
            const totalSecurityDeposit = await this.getSecurityDeposit(
                chainIdentifier, amountBD, swapFee, expiryTimeout,
                baseSDPromise, securityDepositPricePrefetchPromise,
                abortController.signal, metadata
            );
            metadata.times.securityDepositCalculated = Date.now();

            //Calculate claimer bounty
            const totalClaimerBounty = await this.getClaimerBounty(req, expiry, abortController.signal);
            metadata.times.claimerBountyCalculated = Date.now();

            //Create swap data
            const data: SwapData = await swapContract.createSwapData(
                ChainSwapType.CHAIN,
                signer.getAddress(),
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
            data.setTxoHash(this.getTxoHash(receiveAddress, amountBD, this.config.bitcoinNetwork).toString("hex"));
            abortController.signal.throwIfAborted();
            metadata.times.swapCreated = Date.now();

            //Sign the swap
            const sigData = await this.getFromBtcSignatureData(chainIdentifier, data, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap: FromBtcSwapAbs = new FromBtcSwapAbs(chainIdentifier, receiveAddress, amountBD, swapFee, swapFeeInToken);
            createdSwap.data = data;
            createdSwap.metadata = metadata;
            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(createdSwap.data.getHash(), createdSwap.data.getSequence(), createdSwap);

            this.swapLogger.info(createdSwap, "REST: /getAddress: Created swap address: "+receiveAddress+" amount: "+amountBD.toString(10));

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    btcAddress: receiveAddress,
                    address: signer.getAddress(),
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

    getInfoData(): any {
        return {
            confirmations: this.config.confirmations,

            cltv: this.config.swapCsvDelta,
            timestampCltv: this.config.swapTsCsvDelta.toNumber()
        };
    }

}
