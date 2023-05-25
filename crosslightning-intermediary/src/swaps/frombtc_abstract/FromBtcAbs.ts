import * as BN from "bn.js";
import * as lncli from "ln-service";
import {Express} from "express";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
import {SwapNonce} from "../SwapNonce";
import {SwapHandler, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {ChainEvents, ClaimEvent, InitializeEvent,
    IStorageManager,
    RefundEvent, SwapContract, SwapData, SwapEvent, ChainSwapType, TokenAddress} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import * as bitcoin from "bitcoinjs-lib";
import {FromBtcLnSwapAbs, ToBtcSwapAbs} from "../..";


export type FromBtcConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    maxSkew: number,
    safetyFactor: BN,
    bitcoinNetwork: bitcoin.networks.Network

    confirmations: number,
    swapCsvDelta: number,

    refundInterval: number,

    securityDepositAPY: number
};

const secondsInYear = new BN(365*24*60*60);

export class FromBtcAbs<T extends SwapData> extends SwapHandler<FromBtcSwapAbs<T>, T> {

    readonly type = SwapHandlerType.FROM_BTC;

    readonly config: FromBtcConfig & {swapTsCsvDelta: BN};

    constructor(
        storageDirectory: IStorageManager<FromBtcSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any>,
        chainEvents: ChainEvents<T>,
        swapNonce: SwapNonce,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        config: FromBtcConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, swapNonce, allowedTokens, lnd, swapPricing);
        const anyConfig = config as any;
        anyConfig.swapTsCsvDelta = new BN(config.swapCsvDelta).mul(config.bitcoinBlocktime.div(config.safetyFactor));
        this.config = anyConfig;
    }


    getHash(address: string, nonce: BN, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);
        return this.swapContract.getHashForOnchain(parsedOutputScript, amount, nonce);
    }

    getChainHash(swap: FromBtcSwapAbs<T>): Buffer {
        return this.getHash(swap.address, new BN(0), swap.amount, this.config.bitcoinNetwork);
    }

    async checkPastSwaps() {

        const removeSwaps: Buffer[] = [];
        const refundSwaps: FromBtcSwapAbs<T>[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

            const currentTime = new BN(Math.floor(Date.now()/1000)-this.config.maxSkew);

            if(swap.state===FromBtcSwapState.CREATED) {
                //Invoice is expired
                if(swap.authorizationExpiry.lt(currentTime)) {
                    removeSwaps.push(this.getChainHash(swap));
                }
                continue;
            }

            const expiryTime = swap.data.getExpiry();
            if(swap.state===FromBtcSwapState.COMMITED) {
                if(expiryTime.lt(currentTime)) {
                    const isCommited = await this.swapContract.isCommited(swap.data);

                    if(isCommited) {
                        refundSwaps.push(swap);
                    }
                }
            }
        }

        for(let swapHash of removeSwaps) {
            await this.storageManager.removeData(swapHash.toString("hex"));
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;
            await this.swapContract.refund(refundSwap.data, true, false, true);
            unlock();
        }
    }

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {

            if(event instanceof InitializeEvent) {
                if (!this.swapContract.areWeOfferer(event.swapData)) {
                    continue;
                }

                if (event.swapData.isPayIn()) {
                    //Only process requests that don't pay in from the program
                    continue;
                }

                if (event.swapData.getType() !== ChainSwapType.CHAIN) {
                    //Only process nonced on-chain requests
                    continue;
                }

                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");
                const savedSwap = this.storageManager.data[paymentHash];

                if (savedSwap != null) {
                    savedSwap.state = FromBtcSwapState.COMMITED;
                }

                const usedNonce = event.signatureNonce;
                const tokenAdress = event.swapData.getToken().toString();
                if (usedNonce > this.nonce.getNonce(tokenAdress)) {
                    await this.nonce.saveNonce(tokenAdress, usedNonce);
                }

                if (savedSwap != null) {
                    savedSwap.data = event.swapData;
                    await this.storageManager.saveData(paymentHashBuffer.toString("hex"), savedSwap);
                }

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHashHex = event.paymentHash;
                const paymentHash: Buffer = Buffer.from(paymentHashHex, "hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                if (savedSwap == null) {
                    continue;
                }

                console.log("[From BTC: Solana.ClaimEvent] Swap claimed by claimer: ", paymentHashHex);
                await this.storageManager.removeData(paymentHash.toString("hex"));

                continue;
            }
            if(event instanceof RefundEvent) {
                continue;
            }
        }

        return true;
    }

    startRestServer(restServer: Express) {

        restServer.post(this.path+"/getAddress", async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to use
             * claimerBounty: object        Data for calculating claimer bounty
             *  - feePerBlock: string           Fee per block to be synchronized with btc relay
             *  - safetyFactor: number          Safety factor to multiply required blocks (when using 10 min block time)
             *  - startTimestamp: string        UNIX seconds used for timestamp delta calc
             *  - addBlock: number              Additional blocks to add to the calculation
             */

            if(
                req.body==null ||

                req.body.claimerBounty==null ||
                typeof(req.body.claimerBounty)!=="object" ||

                req.body.claimerBounty.feePerBlock==null ||
                typeof(req.body.claimerBounty.feePerBlock)!=="string" ||

                req.body.claimerBounty.safetyFactor==null ||
                typeof(req.body.claimerBounty.safetyFactor)!=="number" ||

                req.body.claimerBounty.startTimestamp==null ||
                typeof(req.body.claimerBounty.startTimestamp)!=="string" ||

                req.body.claimerBounty.addBlock==null ||
                typeof(req.body.claimerBounty.addBlock)!=="number" ||

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

            let feePerBlockBD: BN;
            try {
                feePerBlockBD = new BN(req.body.claimerBounty.feePerBlock);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (feePerBlock)"
                });
                return;
            }

            let startTimestampBD: BN;
            try {
                startTimestampBD = new BN(req.body.claimerBounty.startTimestamp);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (startTimestamp)"
                });
                return;
            }

            const safetyFactorBD: BN = new BN(req.body.claimerBounty.safetyFactor);
            const addBlockBD: BN = new BN(req.body.claimerBounty.addBlock);

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


            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: this.LND,
                format: "p2wpkh"
            });

            console.log("[From BTC: REST.CreateInvoice] Created receiving address: ", receiveAddress);

            const createdSwap: FromBtcSwapAbs<T> = new FromBtcSwapAbs<T>(receiveAddress, amountBD, swapFee);

            const paymentHash = this.getChainHash(createdSwap);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = this.config.swapTsCsvDelta;

            const expiry = currentTimestamp.add(expiryTimeout);

            //Calculate security deposit
            const baseSD = (await this.swapContract.getRefundFee()).mul(new BN(2));
            console.log("[From BTC: REST.CreateInvoice] Base security deposit: ", baseSD.toString(10));
            const swapValueInNativeCurrency = await this.swapPricing.getFromBtcSwapAmount(amountBD.sub(swapFee), this.swapContract.getNativeCurrencyAddress());
            console.log("[From BTC: REST.CreateInvoice] Swap output value in native currency: ", swapValueInNativeCurrency.toString(10));
            const apyPPM = new BN(Math.floor(this.config.securityDepositAPY*1000000));
            console.log("[From BTC: REST.CreateInvoice] APY PPM: ", apyPPM.toString(10));
            console.log("[From BTC: REST.CreateInvoice] Expiry timeout: ", expiryTimeout.toString(10));
            const variableSD = swapValueInNativeCurrency.mul(apyPPM).mul(expiryTimeout).div(new BN(1000000)).div(secondsInYear);
            console.log("[From BTC: REST.CreateInvoice] Variable security deposit: ", variableSD.toString(10));

            //Calculate claimer bounty
            const tsDelta = expiry.sub(startTimestampBD);
            const blocksDelta = tsDelta.div(this.config.bitcoinBlocktime).mul(safetyFactorBD);
            const totalBlock = blocksDelta.add(addBlockBD);
            const totalClaimerBounty = totalBlock.mul(feePerBlockBD);

            const data: T = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN,
                this.swapContract.getAddress(),
                req.body.address,
                useToken,
                amountInToken.sub(swapFeeInToken),
                paymentHash.toString("hex"),
                expiry,
                new BN(0),
                this.config.confirmations,
                false,
                true,
                baseSD.add(variableSD),
                totalClaimerBounty
            );

            createdSwap.data = data;

            const sigData = await this.swapContract.getInitSignature(data, this.nonce, this.config.authorizationTimeout);

            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await this.storageManager.saveData(this.getChainHash(createdSwap).toString("hex"), createdSwap);

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    btcAddress: receiveAddress,
                    address: this.swapContract.getAddress(),
                    swapFee: swapFeeInToken.toString(10),
                    total: amountInToken.sub(swapFeeInToken).toString(10),
                    data: data.serialize(),
                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        console.log("[From BTC: REST] Started at path: ", this.path);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC: Solana.Events] Subscribed to Solana events");
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
        await this.storageManager.loadData(FromBtcSwapAbs);
        this.subscribeToEvents();
    }

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
