import {Express} from "express";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import * as lncli from "ln-service";
import {ToBtcSwapAbs, ToBtcSwapState} from "./ToBtcSwapAbs";
import {SwapHandler, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    BtcTx,
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
import {BitcoinRpc, BtcBlock} from "crosslightning-base/dist";
import {AuthenticatedLnd, pay} from "lightning";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {IBtcFeeEstimator} from "../../fees/IBtcFeeEstimator";
import {coinSelect} from "../../utils/coinselect2";
import {CoinselectAddressTypes, CoinselectTxInput, CoinselectTxOutput, utils} from "../../utils/coinselect2/utils";
import {randomBytes} from "crypto";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import * as express from "express";

const OUTPUT_SCRIPT_MAX_LENGTH = 200;

export type ToBtcConfig = {
    authorizationTimeout: number,
    bitcoinBlocktime: BN,
    gracePeriod: BN,
    baseFee: BN,
    feePPM: BN,
    max: BN,
    min: BN,
    safetyFactor: BN,
    sendSafetyFactor: BN,
    maxSkew: number,

    bitcoinNetwork: bitcoin.networks.Network,

    minChainCltv: BN,

    networkFeeMultiplierPPM: BN,
    minConfirmations: number,
    maxConfirmations: number,
    maxConfTarget: number,
    minConfTarget: number,

    txCheckInterval: number,
    swapCheckInterval: number,

    feeEstimator?: IBtcFeeEstimator,
    onchainReservedPerChannel?: number
};

const CONFIRMATIONS_REQUIRED = 1;

const ADDRESS_FORMAT_MAP = {
    "p2wpkh": "p2wpkh",
    "np2wpkh": "p2sh-p2wpkh",
    "p2tr" : "p2tr"
};

const LND_CHANGE_OUTPUT_TYPE = "p2tr";

/**
 * Handler for to BTC swaps, utilizing PTLCs (proof-time locked contracts) using btc relay (on-chain bitcoin SPV)
 */
export class ToBtcAbs<T extends SwapData> extends SwapHandler<ToBtcSwapAbs<T>, T>  {

    readonly type = SwapHandlerType.TO_BTC;

    activeSubscriptions: {[txId: string]: ToBtcSwapAbs<T>} = {};
    bitcoinRpc: BitcoinRpc<BtcBlock>;

    readonly config: ToBtcConfig;

    constructor(
        storageDirectory: IIntermediaryStorage<ToBtcSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any>,
        chainEvents: ChainEvents<T>,
        allowedTokens: TokenAddress[],
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        bitcoinRpc: BitcoinRpc<BtcBlock>,
        config: ToBtcConfig
    ) {
        super(storageDirectory, path, swapContract, chainEvents, allowedTokens, lnd, swapPricing);
        this.bitcoinRpc = bitcoinRpc;
        this.config = config;
        this.config.onchainReservedPerChannel = this.config.onchainReservedPerChannel || 40000;
    }

    private async getSpendableUtxos(): Promise<{
        address: string,
        address_format: string,
        confirmation_count: number,
        output_script: string,
        tokens: number,
        transaction_id: string,
        transaction_vout: number
    }[]> {

        const resBlockheight = await lncli.getHeight({
            lnd: this.LND
        });

        const blockheight: number = resBlockheight.current_block_height;

        const resChainTxns = await lncli.getChainTransactions({
            lnd: this.LND,
            after: blockheight-CONFIRMATIONS_REQUIRED
        });

        const selfUTXOs: {[txId: string]: boolean} = {};

        const transactions = resChainTxns.transactions;
        for(let tx of transactions) {
            if(tx.is_outgoing) {
                selfUTXOs[tx.id] = true;
            }
        }

        const resUtxos = await lncli.getUtxos({
            lnd: this.LND
        });

        return resUtxos.utxos.filter(utxo => utxo.confirmation_count>=CONFIRMATIONS_REQUIRED || selfUTXOs[utxo.transaction_id]);

    }

    private getChangeAddress(): Promise<{
        addr: string
    }> {
        return new Promise((resolve, reject) => {
            this.LND.wallet.nextAddr({
                type: 4,
                change: true
            }, (err, res) => {
                if(err!=null) {
                    reject([503, 'UnexpectedErrGettingNextAddr', {err}]);
                    return;
                }
                resolve(res);
            });
        });
    }

    private async getChainFee(targetAddress: string, targetAmount: number): Promise<{
        satsPerVbyte: number,
        fee: number,
        inputs: CoinselectTxInput[],
        outputs: CoinselectTxOutput[]
    } | null> {
        const satsPerVbyte: number | null = this.config.feeEstimator==null
            ? await lncli.getChainFeeRate({lnd: this.LND}).then(res => res.tokens_per_vbyte).catch(e => console.error(e))
            : await this.config.feeEstimator.estimateFee();

        if(satsPerVbyte==null) return null;

        const utxos = await this.getSpendableUtxos();

        let totalSpendable = 0;

        const utxoPool: {
            vout: number,
            txId: string,
            value: number,
            type: CoinselectAddressTypes,
            outputScript: Buffer,
            address: string
        }[] = utxos.map(utxo => {
            totalSpendable += utxo.tokens;
            return {
                vout: utxo.transaction_vout,
                txId: utxo.transaction_id,
                value: utxo.tokens,
                type: ADDRESS_FORMAT_MAP[utxo.address_format],
                outputScript: Buffer.from(utxo.output_script, "hex"),
                address: utxo.address
            };
        });

        console.log("[To BTC: getChainFee()] Total spendable value: "+totalSpendable+" num utxos: "+utxoPool.length);

        const targets = [
            {
                address: targetAddress,
                value: targetAmount,
                script: bitcoin.address.toOutputScript(targetAddress, this.config.bitcoinNetwork)
            }
        ];

        let obj = coinSelect(utxoPool, targets, satsPerVbyte, LND_CHANGE_OUTPUT_TYPE);

        if(obj.inputs==null || obj.outputs==null) {
            return null;
        }

        const spentInputs = new Set<string>();
        obj.inputs.forEach(txIn => {
            spentInputs.add(txIn.txId+":"+txIn.vout);
        });

        let leavesValue: number = 0;
        utxoPool.forEach(val => {
            const utxoEconomicalValue = (val.value - (satsPerVbyte * utils.inputBytes(val)));
            if (
                //Utxo not spent
                !spentInputs.has(val.txId + ":" + val.vout) &&
                //Only economical utxos at current fees
                utxoEconomicalValue > 0
            ) {
                leavesValue += utxoEconomicalValue;
            }
        });
        if(obj.outputs.length>1) {
            const changeUtxo = obj.outputs[1];
            leavesValue += changeUtxo.value - (satsPerVbyte * utils.inputBytes(changeUtxo));
        }

        const {channels} = await lncli.getChannels({lnd: this.LND});

        console.log("[To BTC: getChainFee()] Leaves value: "+leavesValue+" required: "+(channels.length*this.config.onchainReservedPerChannel));

        if(leavesValue < channels.length*this.config.onchainReservedPerChannel) {
            return null;
        }

        return {
            fee: obj.fee,
            satsPerVbyte,
            outputs: obj.outputs,
            inputs: obj.inputs
        };

    }

    /**
     * Returns the payment hash of the swap, takes swap nonce into account. Payment hash is chain-specific.
     *
     * @param address
     * @param nonce
     * @param amount
     * @param bitcoinNetwork
     */
    private getHash(address: string, nonce: BN, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);
        return this.swapContract.getHashForOnchain(parsedOutputScript, amount, nonce);
    }

    /**
     * Returns payment hash of the swap (hash WITH using payment nonce)
     *
     * @param swap
     */
    private getChainHash(swap: ToBtcSwapAbs<T>): Buffer {
        return this.getHash(swap.address, swap.nonce, swap.amount, this.config.bitcoinNetwork);
    }

    /**
     * Tries to claim the swap after our transaction was confirmed
     *
     * @param tx
     * @param payment
     * @param vout
     */
    private async processPaymentResult(tx: {blockhash: string, confirmations: number, txid: string, hex: string}, payment: ToBtcSwapAbs<T>, vout: number): Promise<boolean> {
        //Set flag that we are sending the transaction already, so we don't end up with race condition
        const blockHeader = await this.bitcoinRpc.getBlockHeader(tx.blockhash);

        const unlock: () => boolean = payment.lock(this.swapContract.claimWithTxDataTimeout);

        if(unlock==null) return false;

        const result = await this.swapContract.claimWithTxData(payment.data, blockHeader.getHeight(), tx, vout, null, null, false, true);

        if(payment.metadata!=null) payment.metadata.times.txClaimed = Date.now();

        unlock();

        return true;
    }

    /**
     * Checks past swaps, deletes ones that are already expired.
     */
    private async checkPastSwaps() {

        const queriedData = await this.storageManager.query([
            {
                key: "state",
                values: [
                    ToBtcSwapState.SAVED,
                    ToBtcSwapState.NON_PAYABLE,
                    ToBtcSwapState.COMMITED,
                    ToBtcSwapState.BTC_SENDING,
                    ToBtcSwapState.BTC_SENT,
                ]
            }
        ]);

        for(let payment of queriedData) {
            const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew));

            if(payment.state===ToBtcSwapState.SAVED && payment.signatureExpiry!=null) {
                if(payment.signatureExpiry.lt(timestamp)) {
                    const isCommitted = await this.swapContract.isCommited(payment.data);
                    if(!isCommitted) {
                        //Signature expired
                        await payment.setState(ToBtcSwapState.CANCELED);
                        // await PluginManager.swapStateChange(payment);
                        await this.removeSwapData(this.getChainHash(payment).toString("hex"), payment.data.getSequence());
                    } else {
                        await payment.setState(ToBtcSwapState.COMMITED);
                        await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);
                    }
                    continue;
                }
            }

            if(payment.state===ToBtcSwapState.NON_PAYABLE || payment.state===ToBtcSwapState.SAVED) {
                if(payment.data.getExpiry().lt(timestamp)) {
                    //Expired
                    await payment.setState(ToBtcSwapState.CANCELED);
                    // await PluginManager.swapStateChange(payment);
                    await this.removeSwapData(this.getChainHash(payment).toString("hex"), payment.data.getSequence());
                    continue;
                }
            }

            if(payment.state===ToBtcSwapState.COMMITED || payment.state===ToBtcSwapState.BTC_SENDING || payment.state===ToBtcSwapState.BTC_SENT) {
                await this.processInitialized(payment);
                continue;
            }

        }

    }

    /**
     * Checks active sent out bitcoin transactions
     */
    private async checkBtcTxs() {

        const removeTxIds = [];

        for(let txId in this.activeSubscriptions) {
            try {
                const payment: ToBtcSwapAbs<T> = this.activeSubscriptions[txId];
                let tx: BtcTx = await this.bitcoinRpc.getTransaction(txId);

                if(tx==null) {
                    continue;
                }

                tx.confirmations = tx.confirmations || 0;

                const hasEnoughConfirmations = tx.confirmations>=payment.data.getConfirmations();
                if(!hasEnoughConfirmations) {
                    continue;
                }

                const outputScript = bitcoin.address.toOutputScript(payment.address, this.config.bitcoinNetwork);

                console.log("[To BTC: Bitcoin.CheckTransactions] TX vouts: ", tx.outs);
                console.log("[To BTC: Bitcoin.CheckTransactions] Required output script: ", outputScript.toString("hex"));
                console.log("[To BTC: Bitcoin.CheckTransactions] Required amount: ", payment.amount.toString(10));

                const vout = tx.outs.find(e => new BN(e.value).eq(payment.amount) && Buffer.from(e.scriptPubKey.hex, "hex").equals(outputScript));

                if(vout==null) {
                    console.error("Cannot find vout!!");
                    continue;
                }

                if(payment.metadata!=null) payment.metadata.times.payTxConfirmed = Date.now();

                const success = await this.processPaymentResult(tx, payment, vout.n);

                console.log("[To BTC: Bitcoin.CheckTransactions] Claim processed: ", txId);

                if(success) removeTxIds.push(txId);
            } catch (e) {
                console.error(e);
            }
        }

        removeTxIds.forEach(txId => {
            console.log("[ToBtc: Bitcoin.CheckTransactions] Removing from txId subscriptions: ", txId);
            delete this.activeSubscriptions[txId];
        });

        //if(removeTxIds.length>0) console.log("[ToBtc: Bitcoin.CheckTransactions] Still subscribed to: ", Object.keys(this.activeSubscriptions));
    }

    /**
     * Subscribes to and periodically checks txId used to send out funds for the swap for enough confirmations
     *
     * @param payment
     */
    private subscribeToPayment(payment: ToBtcSwapAbs<T>) {
        this.activeSubscriptions[payment.txId] = payment;
    }

    /**
     * Called after swap was successfully committed, will check if bitcoin tx is already sent, if not tries to send it and subscribes to it
     *
     * @param payment
     * @param data
     */
    private async processInitialized(payment: ToBtcSwapAbs<T>) {

        if(payment.state===ToBtcSwapState.BTC_SENDING) {
            //Payment was signed (maybe also sent)
            const tx = await this.bitcoinRpc.getTransaction(payment.txId);

            const isTxSent = tx!=null;

            if(!isTxSent) {
                //Reset the state to COMMITED
                await payment.setState(ToBtcSwapState.COMMITED);
                // await PluginManager.swapStateChange(payment);
            } else {
                await payment.setState(ToBtcSwapState.BTC_SENT);
                // await PluginManager.swapStateChange(payment);
                await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);
            }
        }

        const setNonPayableAndSave = async() => {
            await payment.setState(ToBtcSwapState.NON_PAYABLE);
            // await PluginManager.swapStateChange(payment);
            await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);
        };

        if(payment.state===ToBtcSwapState.SAVED) {
            if(!payment.data.isToken(payment.data.getToken())) {
                console.error("[To BTC: Solana.Initialize] Invalid token used");
                await setNonPayableAndSave();
                return;
            }

            await payment.setState(ToBtcSwapState.COMMITED);
            // await PluginManager.swapStateChange(payment);
            await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);
        }

        if(payment.state===ToBtcSwapState.COMMITED) {
            console.log("[To BTC: Solana.Initialize] Struct: ", payment.data);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const tsDelta = payment.data.getExpiry().sub(currentTimestamp);

            const minRequiredCLTV = this.getExpiryFromCLTV(payment.preferedConfirmationTarget, payment.data.getConfirmations());

            const hasRequiredCLTVDelta = tsDelta.gte(minRequiredCLTV);
            if(!hasRequiredCLTVDelta) {
                console.error("[To BTC: Solana.Initialize] TS delta too low, required: "+minRequiredCLTV.toString(10)+" has: "+tsDelta.toString(10));
                await setNonPayableAndSave();
                return;
            }

            const unlock: () => boolean = payment.lock(60);

            if(unlock==null) return;

            if(payment.metadata!=null) payment.metadata.times.payCLTVChecked = Date.now();

            const coinselectResult = await this.getChainFee(payment.address, payment.amount.toNumber());

            if(coinselectResult==null) {
                console.error("[To BTC: Solana.Initialize] Failed to run coinselect algorithm (not enough funds?)");
                await setNonPayableAndSave();
                unlock();
                return;
            }

            if(payment.metadata!=null) payment.metadata.times.payChainFee = Date.now();

            //Check tx fee
            const feeRate = new BN(coinselectResult.satsPerVbyte);
            const swapPaysEnoughNetworkFee = payment.satsPerVbyte.gte(feeRate);
            if(!swapPaysEnoughNetworkFee) {
                //TODO: Here we can maybe retry with a bit different confirmation target
                console.error("[To BTC: Solana.Initialize] Fee changed too much! Max possible feerate: "+payment.satsPerVbyte.toString(10)+" sats/vB required feerate: "+feeRate.toString(10)+" sats/vB");
                await setNonPayableAndSave();
                unlock();
                return;
            }

            let psbt = new bitcoin.Psbt();

            //Apply nonce
            const nonceBN = payment.data.getEscrowNonce();
            const nonceBuffer = Buffer.from(nonceBN.toArray("be", 8));

            const locktimeBN = new BN(nonceBuffer.slice(0, 5), "be");
            const sequenceBN = new BN(nonceBuffer.slice(5, 8), "be");

            let locktime = locktimeBN.toNumber();
            console.log("[To BTC: Solana.Initialize] Nonce locktime: ", locktime);

            locktime += 500000000;
            psbt.setLocktime(locktime);

            console.log("[To BTC: Solana.Initialize] Nonce sequence base: ", sequenceBN.toNumber());
            const sequence = 0xFE000000 + sequenceBN.toNumber();
            console.log("[To BTC: Solana.Initialize] Nonce sequence: ", sequence);

            psbt.addInputs(coinselectResult.inputs.map(input => {
                return {
                    hash: input.txId,
                    index: input.vout,
                    witnessUtxo: {
                        script: input.outputScript,
                        value: input.value
                    },
                    sighashType: 0x01,
                    sequence
                };
            }));

            psbt.addOutput({
                script: bitcoin.address.toOutputScript(payment.address, this.config.bitcoinNetwork),
                value: payment.amount.toNumber()
            });

            if(coinselectResult.outputs.length>1) {
                psbt.addOutput({
                    script: bitcoin.address.toOutputScript((await this.getChangeAddress()).addr, this.config.bitcoinNetwork),
                    value: coinselectResult.outputs[1].value
                });
            }

            //Sign the PSBT
            const psbtHex = psbt.toHex();

            let signedPsbt;
            try {
                signedPsbt = await lncli.signPsbt({
                    lnd: this.LND,
                    psbt: psbtHex
                });
            } catch (e) {
                console.error(e);
            }

            if(payment.metadata!=null) payment.metadata.times.paySignPSBT = Date.now();

            if(signedPsbt==null) {
                console.error("[To BTC: Solana.Initialize] Failed to sign psbt!");
                unlock();
                return;
            }

            psbt = bitcoin.Psbt.fromHex(signedPsbt.psbt);

            const txFee = new BN(psbt.getFee());
            // //Check tx fee
            // const swapPaysEnoughNetworkFee = maxNetworkFee.gte(txFee);
            // if(!swapPaysEnoughNetworkFee) {
            //     //TODO: Here we can maybe retry with a bit different confirmation target
            //     console.error("[To BTC: Solana.Initialize] Fee changed too much! Max possible fee: "+maxNetworkFee.toString(10)+" required transaction fee: "+txFee.toString(10));
            //     await setNonPayableAndSave();
            //     unlock();
            //     return;
            // }

            //Send BTC TX
            console.log("[To BTC: Solana.Initialize] Generated raw transaction: ", signedPsbt.transaction);

            const tx = bitcoin.Transaction.fromHex(signedPsbt.transaction);
            const txId = tx.getId();

            //Sanity check on sats/vB
            const maxAllowedFee = new BN(tx.virtualSize())
                //Considering the extra output was not added, because was detrminetal
                .add(new BN(utils.outputBytes({type: LND_CHANGE_OUTPUT_TYPE})))
                //Multiply by maximum allowed feerate
                .mul(payment.satsPerVbyte)
                //Possibility that extra output was not added due to it being lower than dust
                .add(new BN(utils.dustThreshold({type: LND_CHANGE_OUTPUT_TYPE})));

            if(txFee.gt(maxAllowedFee)) {
                console.error("[To BTC: SC.Initialize: "+Date.now()+"] Generated tx fee too high, max allowed: "+maxAllowedFee.toString(10)+", got: "+txFee.toString()+" !");
                console.error("PSBT HEX: ", psbt.toHex());
                console.error("Coinselect result: ", JSON.stringify(coinselectResult));
                console.error("Fee rate: ", feeRate.toString(10));
                console.error("Max allowed feerate: ", payment.satsPerVbyte.toString(10));
                unlock();
                return;
            }

            payment.txId = txId;
            payment.realNetworkFee = txFee;
            await payment.setState(ToBtcSwapState.BTC_SENDING);
            // await PluginManager.swapStateChange(payment);
            await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);

            let txSendResult;
            try {
                txSendResult = await lncli.broadcastChainTransaction({
                    lnd: this.LND,
                    transaction: signedPsbt.transaction
                });
            } catch (e) {
                console.error(e);
            }

            if(payment.metadata!=null) payment.metadata.times.payTxSent = Date.now();

            if(txSendResult==null) {
                console.error("[To BTC: Solana.Initialize] Failed to broadcast transaction!");
                unlock();
                return;
            }

            await payment.setState(ToBtcSwapState.BTC_SENT);
            // await PluginManager.swapStateChange(payment);
            await this.storageManager.saveData(this.getChainHash(payment).toString("hex"), payment.data.getSequence(), payment);
            unlock();
        }

        if(payment.state===ToBtcSwapState.NON_PAYABLE) return;

        this.subscribeToPayment(payment);

    }

    /**
     * Chain event handler
     *
     * @param eventData
     */
    private async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {
        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                if(event.swapType!==ChainSwapType.CHAIN_NONCED) {
                    //Only process nonced on-chain requests
                    continue;
                }

                const paymentHash = event.paymentHash;

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    // console.error("[To BTC: Solana.Initialize] No invoice submitted");
                    continue;
                }

                if(savedInvoice.metadata!=null) savedInvoice.metadata.times.txReceived = Date.now();

                console.log("[To BTC: Solana.Initialize] SOL request submitted");

                await this.processInitialized(savedInvoice);

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHash = event.paymentHash;

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.ClaimEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await savedInvoice.setState(ToBtcSwapState.CLAIMED);
                await this.removeSwapData(paymentHash, event.sequence);

                continue;
            }
            if(event instanceof RefundEvent) {
                const paymentHash = event.paymentHash;

                const savedInvoice = await this.storageManager.getData(paymentHash, event.sequence);

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.RefundEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.RefundEvent] Transaction refunded! Event: ", event);

                //Also remove transaction from active subscriptions
                if(savedInvoice.txId!=null) {
                    if(this.activeSubscriptions[savedInvoice.txId]!=null) {
                        delete this.activeSubscriptions[savedInvoice.txId];
                    }
                }

                await savedInvoice.setState(ToBtcSwapState.REFUNDED);
                await this.removeSwapData(paymentHash, event.sequence);

                continue;
            }
        }

        return true;
    }

    /**
     * Returns required expiry delta for swap params
     *
     * @param confirmationTarget
     * @param confirmations
     */
    private getExpiryFromCLTV(confirmationTarget: number, confirmations: number): BN {
        //Blocks = 10 + (confirmations + confirmationTarget)*2
        //Time = 3600 + (600*blocks*2)
        const cltv = this.config.minChainCltv.add(
            new BN(confirmations).add(new BN(confirmationTarget)).mul(this.config.sendSafetyFactor)
        );

        return this.config.gracePeriod.add(this.config.bitcoinBlocktime.mul(cltv).mul(this.config.safetyFactor));

    }

    startRestServer(restServer: Express) {
        restServer.use(this.path+"/payInvoice", express.json());
        restServer.post(this.path+"/payInvoice", expressHandlerWrapper(async (req, res) => {
            const metadata: {
                request: any,
                times: {[key: string]: number}
            } = {request: req.body, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             * address: string                      Bitcoin destination address
             * amount: string                       Amount to send (in satoshis)
             * confirmationTarget: number           Desired confirmation target for the swap, how big of a fee should be assigned to TX
             * confirmations: number                Required number of confirmations for us to claim the swap
             * nonce: string                        Nonce for the swap (used for replay protection)
             * token: string                        Desired token to use
             * offerer: string                      Address of the caller
             * exactIn: boolean                     Whether the swap should be an exact in instead of exact out swap
             * feeRate: string                      Fee rate to be used for the init signature
             */
            const parsedBody = verifySchema(req.body, {
                address: FieldTypeEnum.String,
                amount: FieldTypeEnum.BN,
                confirmationTarget: FieldTypeEnum.Number,
                confirmations: FieldTypeEnum.Number,
                nonce: FieldTypeEnum.BN,
                token: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.allowedTokens.has(val) ? val : null,
                offerer: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        this.swapContract.isValidAddress(val) ? val : null
            });

            if (parsedBody==null) {
                res.status(400).json({
                    msg: "Invalid request body"
                });
                return;
            }

            if(parsedBody.nonce.isNeg()) {
                res.status(400).json({
                    msg: "Invalid request body (nonce - cannot be parsed)"
                });
                return;
            }

            const nonceBuffer = Buffer.from(parsedBody.nonce.toArray("be", 8));
            const firstPart = new BN(nonceBuffer.slice(0, 5), "be");

            const maxAllowedValue = new BN(Math.floor(Date.now()/1000)-600000000);
            if(firstPart.gt(maxAllowedValue)) {
                res.status(400).json({
                    msg: "Invalid request body (nonce - too high)"
                });
                return;
            }

            if(parsedBody.confirmationTarget>this.config.maxConfTarget) {
                res.status(400).json({
                    msg: "Invalid request body (confirmationTarget - too high)"
                });
                return;
            }
            if(parsedBody.confirmationTarget<this.config.minConfTarget) {
                res.status(400).json({
                    msg: "Invalid request body (confirmationTarget - too low)"
                });
                return;
            }

            if(parsedBody.confirmations>this.config.maxConfirmations) {
                res.status(400).json({
                    msg: "Invalid request body (confirmations - too high)"
                });
                return;
            }
            if(parsedBody.confirmations<this.config.minConfirmations) {
                res.status(400).json({
                    msg: "Invalid request body (confirmations - too low)"
                });
                return;
            }

            let parsedOutputScript;

            try {
                parsedOutputScript = bitcoin.address.toOutputScript(parsedBody.address, this.config.bitcoinNetwork);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (address - cannot be parsed)"
                });
                return;
            }

            if(parsedOutputScript.length > OUTPUT_SCRIPT_MAX_LENGTH) {
                res.status(400).json({
                    msg: "Invalid request body (address's output script - too long)"
                });
                return;
            }

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            metadata.times.requestChecked = Date.now();

            const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken).catch(e => {
                console.error("To BTC: REST.pricePrefetch", e);
                throw e;
            }) : null;
            const signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
                console.error("To BTC: REST.signDataPrefetch", e);
                throw e;
            }) : null;

            if(pricePrefetchPromise!=null) console.log("[To BTC: REST.payInvoice] Pre-fetching swap price!");
            if(signDataPrefetchPromise!=null) console.log("[To BTC: REST.payInvoice] Pre-fetching signature data!");

            let tooLow = false;
            let amountBD: BN;
            if(req.body.exactIn) {
                amountBD = await this.swapPricing.getToBtcSwapAmount(parsedBody.amount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                //Decrease by base fee
                amountBD = amountBD.sub(this.config.baseFee);

                //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
                if(amountBD.lt(this.config.min)) {
                    amountBD = this.config.min;
                    tooLow = true;
                }
            } else {
                amountBD = parsedBody.amount;

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
            }

            metadata.times.amountsChecked = Date.now();

            let chainFeeResp = await this.getChainFee(parsedBody.address, amountBD.toNumber());

            metadata.times.chainFeeFetched = Date.now();

            const hasEnoughFunds = chainFeeResp!=null;
            if(!hasEnoughFunds) {
                res.status(400).json({
                    code: 20002,
                    msg: "Insufficient liquidity!"
                });
                return;
            }

            const networkFee = chainFeeResp.fee;
            const feeSatsPervByte = chainFeeResp.satsPerVbyte;

            console.log("[To BTC: REST.PayInvoice] Total network fee: ", networkFee);
            console.log("[To BTC: REST.PayInvoice] Network fee (sats/vB): ", feeSatsPervByte);

            const networkFeeAdjusted = new BN(networkFee).mul(this.config.networkFeeMultiplierPPM).div(new BN(1000000));
            const feeSatsPervByteAdjusted = new BN(feeSatsPervByte).mul(this.config.networkFeeMultiplierPPM).div(new BN(1000000));

            console.log("[To BTC: REST.PayInvoice] Adjusted total network fee: ", networkFeeAdjusted.toString(10));
            console.log("[To BTC: REST.PayInvoice] Adjusted network fee (sats/vB): ", feeSatsPervByteAdjusted.toString(10));

            if(req.body.exactIn) {
                //Decrease by network fee
                amountBD = amountBD.sub(networkFeeAdjusted);

                //Decrease by percentage fee
                amountBD = amountBD.mul(new BN(1000000)).div(this.config.feePPM.add(new BN(1000000)));

                if(tooLow || amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                    //Compute min/max
                    let adjustedMin = this.config.min.mul(this.config.feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(this.config.feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(this.config.baseFee).add(networkFeeAdjusted);
                    adjustedMax = adjustedMax.add(this.config.baseFee).add(networkFeeAdjusted);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    res.status(400).json({
                        code: 20003,
                        msg: "Amount too low!",
                        data: {
                            min: minIn.toString(10),
                            max: maxIn.toString(10)
                        }
                    });
                    return;
                }
                if(amountBD.gt(this.config.max.mul(new BN(105)).div(new BN(100)))) {
                    let adjustedMin = this.config.min.mul(this.config.feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(this.config.feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(this.config.baseFee).add(networkFeeAdjusted);
                    adjustedMax = adjustedMax.add(this.config.baseFee).add(networkFeeAdjusted);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    res.status(400).json({
                        code: 20004,
                        msg: "Amount too high!",
                        data: {
                            min: minIn.toString(10),
                            max: maxIn.toString(10)
                        }
                    });
                    return;
                }
            }

            metadata.times.chainFeeCalculated = Date.now();

            const swapFee = this.config.baseFee.add(amountBD.mul(this.config.feePPM).div(new BN(1000000)));

            const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(networkFeeAdjusted, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

            let amountInToken: BN;
            let total: BN;
            if(req.body.exactIn) {
                amountInToken = parsedBody.amount.sub(swapFeeInToken).sub(networkFeeInToken);
                total = parsedBody.amount;
            } else {
                amountInToken = await this.swapPricing.getFromBtcSwapAmount(parsedBody.amount, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                total = amountInToken.add(swapFeeInToken).add(networkFeeInToken);
            }

            metadata.times.priceCalculated = Date.now();

            const paymentHash = this.getHash(parsedBody.address, parsedBody.nonce, amountBD, this.config.bitcoinNetwork).toString("hex");

            //Add grace period another time, so the user has 1 hour to commit
            const expirySeconds = this.getExpiryFromCLTV(parsedBody.confirmationTarget, parsedBody.confirmations).add(new BN(this.config.gracePeriod));
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const minRequiredExpiry = currentTimestamp.add(expirySeconds);

            const sequence = new BN(randomBytes(8));
            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN_NONCED,
                parsedBody.offerer,
                this.swapContract.getAddress(),
                useToken,
                total,
                paymentHash,
                sequence,
                minRequiredExpiry,
                parsedBody.nonce,
                parsedBody.confirmations,
                true,
                false,
                new BN(0),
                new BN(0)
            );

            metadata.times.swapCreated = Date.now();

            const feeRate = req.body.feeRate!=null && typeof(req.body.feeRate)==="string" ? req.body.feeRate : null;
            const sigData = await this.swapContract.getClaimInitSignature(
                payObject,
                this.config.authorizationTimeout,
                signDataPrefetchPromise==null ? null : await signDataPrefetchPromise,
                feeRate
            );

            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcSwapAbs<T>(parsedBody.address, amountBD, swapFee, networkFeeAdjusted, feeSatsPervByteAdjusted, parsedBody.nonce, parsedBody.confirmationTarget, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(paymentHash, sequence, createdSwap);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    address: this.swapContract.getAddress(),
                    satsPervByte: feeSatsPervByteAdjusted.toString(10),
                    networkFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    totalFee: swapFeeInToken.add(networkFeeInToken).toString(10),
                    total: total.toString(10),
                    minRequiredExpiry: minRequiredExpiry.toString(10),

                    data: payObject.serialize(),

                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        }));

        const getRefundAuthorization = expressHandlerWrapper(async (req, res) => {
            /**
             * paymentHash: string              Payment hash identifier of the swap
             * sequence: BN                     Sequence identifier of the swap
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
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            if(parsedBody.sequence.isNeg() || parsedBody.sequence.gte(new BN(2).pow(new BN(64)))) {
                res.status(400).json({
                    msg: "Invalid sequence"
                });
                return;
            }

            const payment = await this.storageManager.getData(parsedBody.paymentHash, parsedBody.sequence);

            if (payment == null || payment.state === ToBtcSwapState.SAVED) {
                res.status(200).json({
                    code: 20007,
                    msg: "Payment not found"
                });
                return;
            }

            const isExpired = payment.data.getExpiry().lt(new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew)));

            if(isExpired) {
                res.status(200).json({
                    code: 20010,
                    msg: "Payment expired"
                });
                return;
            }

            if (payment.state === ToBtcSwapState.COMMITED) {
                res.status(200).json({
                    code: 20008,
                    msg: "Payment processing"
                });
                return;
            }

            if (payment.state === ToBtcSwapState.BTC_SENT || payment.state===ToBtcSwapState.BTC_SENDING) {
                res.status(200).json({
                    code: 20006,
                    msg: "Already paid",
                    data: {
                        txId: payment.txId
                    }
                });
                return;
            }

            if (payment.state === ToBtcSwapState.NON_PAYABLE) {
                const isCommited = await this.swapContract.isCommited(payment.data);

                if (!isCommited) {
                    res.status(400).json({
                        code: 20005,
                        msg: "Not committed"
                    });
                    return;
                }

                const refundResponse = await this.swapContract.getRefundSignature(payment.data, this.config.authorizationTimeout);

                // if(payment.refundAuthTimeout==null) {
                //     payment.refundAuthTimeout = new BN(refundResponse.timeout);
                // } else {
                //     payment.refundAuthTimeout = BN.max(payment.refundAuthTimeout, new BN(refundResponse.timeout));
                // }

                //Double check the state after promise result
                if (payment.state !== ToBtcSwapState.NON_PAYABLE) {
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
                        prefix: refundResponse.prefix,
                        timeout: refundResponse.timeout,
                        signature: refundResponse.signature
                    }
                });
                return;
            }

            res.status(500).json({
                code: 20009,
                msg: "Invalid payment status"
            });
        });

        restServer.post(this.path+"/getRefundAuthorization", getRefundAuthorization);
        restServer.get(this.path+"/getRefundAuthorization", getRefundAuthorization);

        console.log("[To BTC: REST] Started at path: ", this.path);
    }

    /**
     * Subscribes to on-chain events
     */
    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[To BTC: Solana.Events] Subscribed to Solana events");
    }

    /**
     * Starts watchdog checking past swaps
     */
    private async startPastSwapsTimer() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps().catch( e => console.error(e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    /**
     * Starts watchdog checking sent bitcoin transactions
     */
    private async startTxTimer() {
        let rerun;
        rerun = async () => {
            await this.checkBtcTxs().catch( e => console.error(e));
            setTimeout(rerun, this.config.txCheckInterval);
        };
        await rerun();
    }

    async startWatchdog() {
        await this.startPastSwapsTimer();
        await this.startTxTimer();
    }

    async init() {
        await this.storageManager.loadData(ToBtcSwapAbs);
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
                minCltv: this.config.minChainCltv.toNumber(),

                minConfirmations: this.config.minConfirmations,
                maxConfirmations: this.config.maxConfirmations,

                minConfTarget: this.config.minConfTarget,
                maxConfTarget: this.config.maxConfTarget,

                maxOutputScriptLen: OUTPUT_SCRIPT_MAX_LENGTH
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }

}
