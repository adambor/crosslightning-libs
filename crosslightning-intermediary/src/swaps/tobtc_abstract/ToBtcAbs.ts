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
    SwapCommitStatus,
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
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {ToBtcLnSwapState} from "../..";

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

export type ToBtcRequestType = {
    address: string,
    amount: BN,
    confirmationTarget: number,
    confirmations: number,
    nonce: BN,
    token: string,
    offerer: string,
    exactIn?: boolean
};

/**
 * Handler for to BTC swaps, utilizing PTLCs (proof-time locked contracts) using btc relay (on-chain bitcoin SPV)
 */
export class ToBtcAbs<T extends SwapData> extends SwapHandler<ToBtcSwapAbs<T>, T>  {

    readonly type = SwapHandlerType.TO_BTC;

    activeSubscriptions: {[txId: string]: ToBtcSwapAbs<T>} = {};
    bitcoinRpc: BitcoinRpc<BtcBlock>;

    readonly config: ToBtcConfig;

    readonly pdaExistsForToken: {
        [token: string]: boolean
    } = {};

    constructor(
        storageDirectory: IIntermediaryStorage<ToBtcSwapAbs<T>>,
        path: string,
        swapContract: SwapContract<T, any, any, any>,
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

        const selfUTXOs: Set<string> = PluginManager.getWhitelistedTxIds();

        const transactions = resChainTxns.transactions;
        for(let tx of transactions) {
            if(tx.is_outgoing) {
                selfUTXOs.add(tx.id);
            }
        }

        const resUtxos = await lncli.getUtxos({
            lnd: this.LND
        });

        return resUtxos.utxos.filter(utxo => utxo.confirmation_count>=CONFIRMATIONS_REQUIRED || selfUTXOs.has(utxo.transaction_id));

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

    private async getChainFee(targetAddress: string, targetAmount: number, multiplier?: number): Promise<{
        satsPerVbyte: number,
        fee: number,
        inputs: CoinselectTxInput[],
        outputs: CoinselectTxOutput[]
    } | null> {
        let satsPerVbyte: number | null = this.config.feeEstimator==null
            ? await lncli.getChainFeeRate({lnd: this.LND}).then(res => res.tokens_per_vbyte).catch(e => console.error(e))
            : await this.config.feeEstimator.estimateFee();

        if(satsPerVbyte==null) return null;

        if(multiplier!=null) satsPerVbyte *= multiplier;

        satsPerVbyte = Math.ceil(satsPerVbyte);

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

        try {
            const result = await this.swapContract.claimWithTxData(payment.data, blockHeader.getHeight(), tx, vout, null, null, false, true);
            if(payment.metadata!=null) payment.metadata.times.txClaimed = Date.now();
            unlock();
            return true;
        } catch (e) {
            return false
        }

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

                //Sanity check for sent swaps
                if(payment.state===ToBtcSwapState.BTC_SENT) {
                    const isCommited = await this.swapContract.isCommited(payment.data);

                    if(!isCommited) {
                        const status = await this.swapContract.getCommitStatus(payment.data);
                        if(status===SwapCommitStatus.PAID) {
                            if(payment.txId!=null) {
                                if(this.activeSubscriptions[payment.txId]!=null) {
                                    console.log("[ToBtc: Bitcoin.checkPastSwaps] Removing from txId subscriptions PAID: ", payment.txId);
                                    delete this.activeSubscriptions[payment.txId];
                                }
                            }
                            await payment.setState(ToBtcSwapState.CLAIMED);
                            await this.removeSwapData(this.getChainHash(payment).toString("hex"), payment.data.getSequence());
                        } else if(status===SwapCommitStatus.EXPIRED) {
                            if(payment.txId!=null) {
                                if(this.activeSubscriptions[payment.txId]!=null) {
                                    console.log("[ToBtc: Bitcoin.checkPastSwaps] Removing from txId subscriptions EXPIRED: ", payment.txId);
                                    delete this.activeSubscriptions[payment.txId];
                                }
                            }
                            await payment.setState(ToBtcSwapState.REFUNDED);
                            await this.removeSwapData(this.getChainHash(payment).toString("hex"), payment.data.getSequence());
                        }
                        continue;
                    }
                }

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

                const vout = tx.outs.find(e => new BN(e.value).eq(payment.amount) && Buffer.from(e.scriptPubKey.hex, "hex").equals(outputScript));

                if(vout==null) {
                    console.error("[To BTC: Bitcoin.CheckTransactions] TX vouts: ", tx.outs);
                    console.error("[To BTC: Bitcoin.CheckTransactions] Required output script: ", outputScript.toString("hex"));
                    console.error("[To BTC: Bitcoin.CheckTransactions] Required amount: ", payment.amount.toString(10));
                    console.error("Cannot find vout!!");
                    continue;
                }

                if(payment.metadata!=null) payment.metadata.times.payTxConfirmed = Date.now();

                const success = await this.processPaymentResult(tx, payment, vout.n);

                console.log("[To BTC: Bitcoin.CheckTransactions] Claim processed: "+txId+" success: "+success);

                if(success) removeTxIds.push(txId);
            } catch (e) {
                console.error(e);
            }
        }

        removeTxIds.forEach(txId => {
            console.log("[ToBtc: Bitcoin.CheckTransactions] Removing from txId subscriptions: ", txId);
            if(this.activeSubscriptions[txId]!=null) delete this.activeSubscriptions[txId];
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
                savedInvoice.txIds.init = (event as any).meta?.txId;

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
                savedInvoice.txIds.claim = (event as any).meta?.txId;

                console.log("[To BTC: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                //Also remove transaction from active subscriptions
                if(savedInvoice.txId!=null) {
                    if(this.activeSubscriptions[savedInvoice.txId]!=null) {
                        console.log("[To Btc: Solana.ClaimEvent] Removing from txId subscriptions: ", savedInvoice.txId);
                        delete this.activeSubscriptions[savedInvoice.txId];
                    }
                }

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
                savedInvoice.txIds.refund = (event as any).meta?.txId;

                console.log("[To BTC: Solana.RefundEvent] Transaction refunded! Event: ", event);

                //Also remove transaction from active subscriptions
                if(savedInvoice.txId!=null) {
                    if(this.activeSubscriptions[savedInvoice.txId]!=null) {
                        console.log("[To Btc: Solana.RefundEvent] Removing from txId subscriptions: ", savedInvoice.txId);
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
        restServer.use(this.path+"/payInvoice", serverParamDecoder(10*1000));
        restServer.post(this.path+"/payInvoice", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            metadata.times.requestReceived = Date.now();
            /**
             *Sent initially:
             * address: string                      Bitcoin destination address
             * amount: string                       Amount to send (in satoshis)
             * confirmationTarget: number           Desired confirmation target for the swap, how big of a fee should be assigned to TX
             * confirmations: number                Required number of confirmations for us to claim the swap
             * nonce: string                        Nonce for the swap (used for replay protection)
             * token: string                        Desired token to use
             * offerer: string                      Address of the caller
             * exactIn: boolean                     Whether the swap should be an exact in instead of exact out swap
             *
             *Sent later:
             * feeRate: string                      Fee rate to use for the init signature
             */
            const parsedBody: ToBtcRequestType = await req.paramReader.getParams({
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
                        this.swapContract.isValidAddress(val) ? val : null,
                exactIn: FieldTypeEnum.BooleanOptional
            });

            metadata.request = parsedBody;

            const responseStream = res.responseStream;

            if (parsedBody==null) {
                await responseStream.writeParamsAndEnd({
                    code: 20100,
                    msg: "Invalid request body"
                });
                return;
            }

            if(parsedBody.nonce.isNeg()) {
                await responseStream.writeParamsAndEnd({
                    code: 20021,
                    msg: "Invalid request body (nonce - cannot be parsed)"
                });
                return;
            }

            const nonceBuffer = Buffer.from(parsedBody.nonce.toArray("be", 8));
            const firstPart = new BN(nonceBuffer.slice(0, 5), "be");

            const maxAllowedValue = new BN(Math.floor(Date.now()/1000)-600000000);
            if(firstPart.gt(maxAllowedValue)) {
                await responseStream.writeParamsAndEnd({
                    code: 20022,
                    msg: "Invalid request body (nonce - too high)"
                });
                return;
            }

            if(parsedBody.confirmationTarget>this.config.maxConfTarget) {
                await responseStream.writeParamsAndEnd({
                    code: 20023,
                    msg: "Invalid request body (confirmationTarget - too high)"
                });
                return;
            }
            if(parsedBody.confirmationTarget<this.config.minConfTarget) {
                await responseStream.writeParamsAndEnd({
                    code: 20024,
                    msg: "Invalid request body (confirmationTarget - too low)"
                });
                return;
            }

            if(parsedBody.confirmations>this.config.maxConfirmations) {
                await responseStream.writeParamsAndEnd({
                    code: 20025,
                    msg: "Invalid request body (confirmations - too high)"
                });
                return;
            }
            if(parsedBody.confirmations<this.config.minConfirmations) {
                await responseStream.writeParamsAndEnd({
                    code: 20026,
                    msg: "Invalid request body (confirmations - too low)"
                });
                return;
            }

            let parsedOutputScript;

            try {
                parsedOutputScript = bitcoin.address.toOutputScript(parsedBody.address, this.config.bitcoinNetwork);
            } catch (e) {
                await responseStream.writeParamsAndEnd({
                    code: 20031,
                    msg: "Invalid request body (address - cannot be parsed)"
                });
                return;
            }

            if(parsedOutputScript.length > OUTPUT_SCRIPT_MAX_LENGTH) {
                await responseStream.writeParamsAndEnd({
                    code: 20032,
                    msg: "Invalid request body (address's output script - too long)"
                });
                return;
            }

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            const pluginResult = await PluginManager.onSwapRequestToBtc(req, parsedBody, metadata);

            if(pluginResult.throw) {
                await responseStream.writeParamsAndEnd({
                    code: 29999,
                    msg: pluginResult.throw
                });
                return;
            }

            let baseFee = pluginResult.baseFee || this.config.baseFee;
            let feePPM = pluginResult.feePPM || this.config.feePPM;

            metadata.times.requestChecked = Date.now();

            const abortController = new AbortController();
            const responseStreamAbortController = responseStream.getAbortSignal();
            responseStreamAbortController.addEventListener("abort", () => abortController.abort(responseStreamAbortController.reason));

            if(!this.pdaExistsForToken[parsedBody.token]) {
                const reputation = await this.swapContract.getIntermediaryReputation(this.swapContract.getAddress(), this.swapContract.toTokenAddress(parsedBody.token));
                if(reputation!=null) {
                    this.pdaExistsForToken[parsedBody.token] = true;
                } else {
                    await responseStream.writeParamsAndEnd({
                        code: 20201,
                        msg: "Token not supported!"
                    });
                    return;
                }
            }

            const pricePrefetchPromise: Promise<BN> = this.swapPricing.preFetchPrice!=null ? this.swapPricing.preFetchPrice(useToken).catch(e => {
                console.error("To BTC: REST.pricePrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;
            let signDataPrefetchPromise: Promise<any> = this.swapContract.preFetchBlockDataForSignatures!=null ? this.swapContract.preFetchBlockDataForSignatures().catch(e => {
                console.error("To BTC: REST.signDataPrefetch", e);
                abortController.abort(e);
                return null;
            }) : null;

            if(pricePrefetchPromise!=null) console.log("[To BTC: REST.payInvoice] Pre-fetching swap price!");
            if(signDataPrefetchPromise!=null) {
                signDataPrefetchPromise = signDataPrefetchPromise.then(val => val==null || abortController.signal.aborted ? null : responseStream.writeParams({
                    signDataPrefetch: val
                }).then(() => val).catch(e => {
                    console.error("[To BTC: REST.payInvoice] Send signDataPreFetch error: ", e);
                    abortController.abort(e);
                    return null;
                }));
                if(signDataPrefetchPromise!=null) console.log("[To BTC: REST.payInvoice] Pre-fetching signature data!");
            }

            let tooLow = false;
            let amountBD: BN;
            if(parsedBody.exactIn) {
                amountBD = await this.swapPricing.getToBtcSwapAmount(parsedBody.amount, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

                abortController.signal.throwIfAborted();

                //Decrease by base fee
                amountBD = amountBD.sub(baseFee);

                //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
                if(amountBD.lt(this.config.min)) {
                    amountBD = this.config.min;
                    tooLow = true;
                }

            } else {
                amountBD = parsedBody.amount;

                if(amountBD.lt(this.config.min)) {
                    await responseStream.writeParamsAndEnd({
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
                    await responseStream.writeParamsAndEnd({
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

            let chainFeeResp = await this.getChainFee(parsedBody.address, amountBD.toNumber(), this.config.networkFeeMultiplierPPM.toNumber()/1000000);

            abortController.signal.throwIfAborted();

            metadata.times.chainFeeFetched = Date.now();

            const hasEnoughFunds = chainFeeResp!=null;
            if(!hasEnoughFunds) {
                await responseStream.writeParamsAndEnd({
                    code: 20002,
                    msg: "Not enough liquidity"
                });
                return;
            }

            const networkFeeAdjusted = new BN(chainFeeResp.fee);
            const feeSatsPervByteAdjusted = new BN(chainFeeResp.satsPerVbyte);

            console.log("[To BTC: REST.PayInvoice] Adjusted total network fee: ", networkFeeAdjusted.toString(10));
            console.log("[To BTC: REST.PayInvoice] Adjusted network fee (sats/vB): ", feeSatsPervByteAdjusted.toString());

            if(parsedBody.exactIn) {
                //Decrease by network fee
                amountBD = amountBD.sub(networkFeeAdjusted);

                //Decrease by percentage fee
                amountBD = amountBD.mul(new BN(1000000)).div(feePPM.add(new BN(1000000)));

                if(tooLow || amountBD.lt(this.config.min.mul(new BN(95)).div(new BN(100)))) {
                    //Compute min/max
                    let adjustedMin = this.config.min.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(baseFee).add(networkFeeAdjusted);
                    adjustedMax = adjustedMax.add(baseFee).add(networkFeeAdjusted);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    await responseStream.writeParamsAndEnd({
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
                    let adjustedMin = this.config.min.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    let adjustedMax = this.config.max.mul(feePPM.add(new BN(1000000))).div(new BN(1000000));
                    adjustedMin = adjustedMin.add(baseFee).add(networkFeeAdjusted);
                    adjustedMax = adjustedMax.add(baseFee).add(networkFeeAdjusted);
                    const minIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMin, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    const maxIn = await this.swapPricing.getFromBtcSwapAmount(adjustedMax, useToken, null, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                    await responseStream.writeParamsAndEnd({
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

            const swapFee = baseFee.add(amountBD.mul(feePPM).div(new BN(1000000)));

            const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(networkFeeAdjusted, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);

            abortController.signal.throwIfAborted();

            let amountInToken: BN;
            let total: BN;
            if(parsedBody.exactIn) {
                amountInToken = parsedBody.amount.sub(swapFeeInToken).sub(networkFeeInToken);
                total = parsedBody.amount;
            } else {
                amountInToken = await this.swapPricing.getFromBtcSwapAmount(parsedBody.amount, useToken, true, pricePrefetchPromise==null ? null : await pricePrefetchPromise);
                total = amountInToken.add(swapFeeInToken).add(networkFeeInToken);

                abortController.signal.throwIfAborted();
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

            abortController.signal.throwIfAborted();

            metadata.times.swapCreated = Date.now();

            const feeRateObj = await req.paramReader.getParams({
                feeRate: FieldTypeEnum.String
            }).catch(e => null);

            abortController.signal.throwIfAborted();

            const feeRate = feeRateObj?.feeRate!=null && typeof(feeRateObj.feeRate)==="string" ? feeRateObj.feeRate : null;

            const sigData = await this.swapContract.getClaimInitSignature(
                payObject,
                this.config.authorizationTimeout,
                signDataPrefetchPromise==null ? null : await signDataPrefetchPromise,
                feeRate
            );

            abortController.signal.throwIfAborted();

            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcSwapAbs<T>(parsedBody.address, amountBD, swapFee, networkFeeAdjusted, feeSatsPervByteAdjusted, parsedBody.nonce, parsedBody.confirmationTarget, new BN(sigData.timeout));
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);

            await this.storageManager.saveData(paymentHash, sequence, createdSwap);

            await responseStream.writeParamsAndEnd({
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
