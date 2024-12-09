import {Express, Request, Response} from "express";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import * as lncli from "ln-service";
import {ToBtcSwapAbs, ToBtcSwapState} from "./ToBtcSwapAbs";
import {MultichainData, SwapHandlerType} from "../SwapHandler";
import {ISwapPrice} from "../ISwapPrice";
import {
    BtcTx,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapCommitStatus,
    SwapData
} from "crosslightning-base";
import {BitcoinRpc, BtcBlock} from "crosslightning-base/dist";
import {AuthenticatedLnd} from "lightning";
import {expressHandlerWrapper, HEX_REGEX, isDefinedRuntimeError} from "../../utils/Utils";
import {PluginManager} from "../../plugins/PluginManager";
import {IIntermediaryStorage} from "../../storage/IIntermediaryStorage";
import {IBtcFeeEstimator} from "../../fees/IBtcFeeEstimator";
import {coinSelect} from "../../utils/coinselect2";
import {CoinselectTxInput, CoinselectTxOutput, utils} from "../../utils/coinselect2/utils";
import {randomBytes} from "crypto";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {ToBtcBaseConfig, ToBtcBaseSwapHandler} from "../ToBtcBaseSwapHandler";
import {PromiseQueue} from "promise-queue-ts";

const OUTPUT_SCRIPT_MAX_LENGTH = 200;

type SpendableUtxo = {
    address: string,
    address_format: string,
    confirmation_count: number,
    output_script: string,
    tokens: number,
    transaction_id: string,
    transaction_vout: number
};

export type ToBtcConfig = ToBtcBaseConfig & {
    sendSafetyFactor: BN,

    bitcoinNetwork: bitcoin.networks.Network,

    minChainCltv: BN,

    networkFeeMultiplierPPM: BN,
    minConfirmations: number,
    maxConfirmations: number,
    maxConfTarget: number,
    minConfTarget: number,

    txCheckInterval: number,

    feeEstimator?: IBtcFeeEstimator,
    onchainReservedPerChannel?: number
};

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
export class ToBtcAbs extends ToBtcBaseSwapHandler<ToBtcSwapAbs, ToBtcSwapState>  {
    protected readonly CONFIRMATIONS_REQUIRED = 1;
    protected readonly ADDRESS_FORMAT_MAP = {
        "p2wpkh": "p2wpkh",
        "np2wpkh": "p2sh-p2wpkh",
        "p2tr" : "p2tr"
    };
    protected readonly LND_CHANGE_OUTPUT_TYPE = "p2tr";
    protected readonly UTXO_CACHE_TIMEOUT = 5*1000;
    protected readonly CHANNEL_COUNT_CACHE_TIMEOUT = 30*1000;

    readonly type = SwapHandlerType.TO_BTC;

    activeSubscriptions: {[txId: string]: ToBtcSwapAbs} = {};
    cachedUtxos: {
        utxos: (CoinselectTxInput & {confirmations: number})[],
        timestamp: number
    };
    cachedChannelCount: {
        count: number,
        timestamp: number
    };
    bitcoinRpc: BitcoinRpc<BtcBlock>;
    sendBtcQueue: PromiseQueue = new PromiseQueue();

    readonly config: ToBtcConfig;

    constructor(
        storageDirectory: IIntermediaryStorage<ToBtcSwapAbs>,
        path: string,
        chainData: MultichainData,
        lnd: AuthenticatedLnd,
        swapPricing: ISwapPrice,
        bitcoinRpc: BitcoinRpc<BtcBlock>,
        config: ToBtcConfig
    ) {
        super(storageDirectory, path, chainData, lnd, swapPricing);
        this.bitcoinRpc = bitcoinRpc;
        this.config = config;
        this.config.onchainReservedPerChannel = this.config.onchainReservedPerChannel || 40000;
    }

    /**
     * Returns the payment hash of the swap, takes swap nonce into account. Payment hash is chain-specific.
     *
     * @param chainIdentifier
     * @param address
     * @param nonce
     * @param amount
     * @param bitcoinNetwork
     */
    private getHash(chainIdentifier: string, address: string, nonce: BN, amount: BN, bitcoinNetwork: bitcoin.networks.Network): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(address, bitcoinNetwork);
        const {swapContract} = this.getChain(chainIdentifier);
        return swapContract.getHashForOnchain(parsedOutputScript, amount, nonce);
    }

    /**
     * Returns spendable UTXOs, these are either confirmed UTXOs, or unconfirmed ones that are either whitelisted,
     *  or created by our transactions (and therefore only we could doublespend)
     *
     * @private
     */
    protected async getSpendableUtxos(): Promise<SpendableUtxo[]> {
        const resBlockheight = await lncli.getHeight({
            lnd: this.LND
        });

        const blockheight: number = resBlockheight.current_block_height;

        const resChainTxns = await lncli.getChainTransactions({
            lnd: this.LND,
            after: blockheight-this.CONFIRMATIONS_REQUIRED
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

        return resUtxos.utxos.filter(utxo => utxo.confirmation_count>=this.CONFIRMATIONS_REQUIRED || selfUTXOs.has(utxo.transaction_id));
    }

    /**
     * Returns utxo pool to be used by the coinselection algorithm
     *
     * @private
     */
    protected async getUtxoPool(useCached: boolean = false): Promise<(CoinselectTxInput & {confirmations: number})[]> {
        if(!useCached || this.cachedUtxos==null || this.cachedUtxos.timestamp<Date.now()-this.UTXO_CACHE_TIMEOUT) {
            const utxos = await this.getSpendableUtxos();

            let totalSpendable = 0;
            const utxoPool = utxos.map(utxo => {
                totalSpendable += utxo.tokens;
                return {
                    vout: utxo.transaction_vout,
                    txId: utxo.transaction_id,
                    value: utxo.tokens,
                    type: this.ADDRESS_FORMAT_MAP[utxo.address_format],
                    outputScript: Buffer.from(utxo.output_script, "hex"),
                    address: utxo.address,
                    confirmations: utxo.confirmation_count
                };
            });

            this.cachedUtxos = {
                utxos: utxoPool,
                timestamp: Date.now()
            };

            this.logger.info("getUtxoPool(): total spendable value: "+totalSpendable+" num utxos: "+utxoPool.length);
        }

        return this.cachedUtxos.utxos;
    }

    /**
     * Checks whether a coinselect result leaves enough funds to cover potential lightning anchor transaction fees
     *
     * @param utxoPool
     * @param obj
     * @param satsPerVbyte
     * @param useCached Whether to use a cached channel count
     * @param initialOutputLength
     * @private
     * @returns true if alright, false if the coinselection doesn't leave enough funds for anchor fees
     */
    protected async isLeavingEnoughForLightningAnchors(
        utxoPool: CoinselectTxInput[],
        obj: {inputs?: CoinselectTxInput[], outputs?: CoinselectTxOutput[]},
        satsPerVbyte: BN,
        useCached: boolean = false,
        initialOutputLength: number = 1
    ): Promise<boolean> {
        if(obj.inputs==null || obj.outputs==null) return false;
        const spentInputs = new Set<string>();
        obj.inputs.forEach(txIn => {
            spentInputs.add(txIn.txId+":"+txIn.vout);
        });

        let leavesValue: BN = new BN(0);
        utxoPool.forEach(val => {
            const utxoEconomicalValue: BN = new BN(val.value).sub(satsPerVbyte.mul(new BN(utils.inputBytes(val).length)));
            if (
                //Utxo not spent
                !spentInputs.has(val.txId + ":" + val.vout) &&
                //Only economical utxos at current fees
                !utxoEconomicalValue.isNeg()
            ) {
                leavesValue = leavesValue.add(utxoEconomicalValue);
            }
        });
        if(obj.outputs.length>initialOutputLength) {
            const changeUtxo = obj.outputs[obj.outputs.length-1];
            leavesValue = leavesValue.add(
                new BN(changeUtxo.value).sub(satsPerVbyte.mul(new BN(utils.inputBytes(changeUtxo).length)))
            );
        }

        if(!useCached || this.cachedChannelCount==null || this.cachedChannelCount.timestamp<Date.now()-this.CHANNEL_COUNT_CACHE_TIMEOUT) {
            const {channels} = await lncli.getChannels({lnd: this.LND});
            this.cachedChannelCount = {
                count: channels.length,
                timestamp: Date.now()
            }
        }

        return leavesValue.gt(new BN(this.config.onchainReservedPerChannel).mul(new BN(this.cachedChannelCount.count)));
    }

    /**
     * Gets the change address from the underlying LND instance
     *
     * @private
     */
    protected getChangeAddress(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.LND.wallet.nextAddr({
                type: 4,
                change: true
            }, (err, res) => {
                if(err!=null) {
                    reject([503, 'UnexpectedErrGettingNextAddr', {err}]);
                    return;
                }
                resolve(res.addr);
            });
        });
    }

    /**
     * Computes bitcoin on-chain network fee, takes channel reserve & network fee multiplier into consideration
     *
     * @param targetAddress Bitcoin address to send the funds to
     * @param targetAmount Amount of funds to send to the address
     * @param estimate Whether the chain fee should be just estimated and therefore cached utxo set could be used
     * @param multiplierPPM Multiplier for the sats/vB returned from the fee estimator in PPM (parts per million)
     * @private
     * @returns Fee estimate & inputs/outputs to use when constructing transaction, or null in case of not enough funds
     */
    private async getChainFee(targetAddress: string, targetAmount: number, estimate: boolean = false, multiplierPPM?: BN): Promise<{
        satsPerVbyte: BN,
        networkFee: BN,
        inputs: CoinselectTxInput[],
        outputs: CoinselectTxOutput[]
    } | null> {
        let feeRate: number | null = this.config.feeEstimator==null
            ? await lncli.getChainFeeRate({lnd: this.LND})
                .then(res => res.tokens_per_vbyte)
                .catch(e => this.logger.error("getChainFee(): LND getChainFeeRate error", e))
            : await this.config.feeEstimator.estimateFee();

        if(feeRate==null) return null;

        let satsPerVbyte = new BN(Math.ceil(feeRate));
        if(multiplierPPM!=null) satsPerVbyte = satsPerVbyte.mul(multiplierPPM).div(new BN(1000000));

        const utxoPool: CoinselectTxInput[] = await this.getUtxoPool(estimate);

        let obj = coinSelect(utxoPool, [{
            address: targetAddress,
            value: targetAmount,
            script: bitcoin.address.toOutputScript(targetAddress, this.config.bitcoinNetwork)
        }], satsPerVbyte.toNumber(), this.LND_CHANGE_OUTPUT_TYPE);

        if(obj.inputs==null || obj.outputs==null) return null;

        if(!await this.isLeavingEnoughForLightningAnchors(utxoPool, obj, satsPerVbyte, estimate)) return null;

        this.logger.info("getChainFee(): fee estimated,"+
            " target: "+targetAddress+
            " amount: "+targetAmount.toString(10)+
            " fee: "+obj.fee+
            " sats/vB: "+satsPerVbyte+
            " inputs: "+obj.inputs.length+
            " outputs: "+obj.outputs.length+
            " multiplier: "+(multiplierPPM==null ? 1 : multiplierPPM.toNumber()/1000000));

        return {
            networkFee: new BN(obj.fee),
            satsPerVbyte,
            outputs: obj.outputs,
            inputs: obj.inputs
        };
    }

    /**
     * Tries to claim the swap after our transaction was confirmed
     *
     * @param tx
     * @param payment
     * @param vout
     */
    private async tryClaimSwap(tx: {blockhash: string, confirmations: number, txid: string, hex: string}, swap: ToBtcSwapAbs, vout: number): Promise<boolean> {
        const {swapContract, signer} = this.getChain(swap.chainIdentifier);

        const blockHeader = await this.bitcoinRpc.getBlockHeader(tx.blockhash);

        //Set flag that we are sending the transaction already, so we don't end up with race condition
        const unlock: () => boolean = swap.lock(swapContract.claimWithTxDataTimeout);
        if(unlock==null) return false;

        try {
            this.swapLogger.debug(swap, "tryClaimSwap(): initiate claim of swap, height: "+blockHeader.getHeight()+" utxo: "+tx.txid+":"+vout);
            const result = await swapContract.claimWithTxData(signer, swap.data, blockHeader.getHeight(), tx, vout, null, null, false, {
                waitForConfirmation: true
            });
            this.swapLogger.info(swap, "tryClaimSwap(): swap claimed successfully, height: "+blockHeader.getHeight()+" utxo: "+tx.txid+":"+vout+" address: "+swap.address);
            if(swap.metadata!=null) swap.metadata.times.txClaimed = Date.now();
            unlock();
            return true;
        } catch (e) {
            this.swapLogger.error(swap, "tryClaimSwap(): error occurred claiming swap, height: "+blockHeader.getHeight()+" utxo: "+tx.txid+":"+vout+" address: "+swap.address, e);
            return false
        }
    }

    protected async processPastSwap(swap: ToBtcSwapAbs) {
        const {swapContract, signer} = this.getChain(swap.chainIdentifier);

        const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew));

        if(swap.state===ToBtcSwapState.SAVED && swap.signatureExpiry!=null) {
            const isSignatureExpired = swap.signatureExpiry.lt(timestamp);
            if(isSignatureExpired) {
                const isCommitted = await swapContract.isCommited(swap.data);
                if(!isCommitted) {
                    this.swapLogger.info(swap, "processPastSwap(state=SAVED): authorization expired & swap not committed, cancelling swap, address: "+swap.address);
                    await this.removeSwapData(swap, ToBtcSwapState.CANCELED);
                } else {
                    this.swapLogger.info(swap, "processPastSwap(state=SAVED): swap committed (detected from processPastSwap), address: "+swap.address);
                    await swap.setState(ToBtcSwapState.COMMITED);
                    await this.storageManager.saveData(swap.getHash(), swap.data.getSequence(), swap);
                }
                return;
            }
        }

        if(swap.state===ToBtcSwapState.NON_PAYABLE || swap.state===ToBtcSwapState.SAVED) {
            const isSwapExpired = swap.data.getExpiry().lt(timestamp);
            if(isSwapExpired) {
                this.swapLogger.info(swap, "processPastSwap(state=NON_PAYABLE|SAVED): swap expired, cancelling, address: "+swap.address);
                await this.removeSwapData(swap, ToBtcSwapState.CANCELED);
                return;
            }
        }

        //Sanity check for sent swaps
        if(swap.state===ToBtcSwapState.BTC_SENT) {
            const isCommited = await swapContract.isCommited(swap.data);
            if(!isCommited) {
                const status = await swapContract.getCommitStatus(signer.getAddress(), swap.data);
                if(status===SwapCommitStatus.PAID) {
                    this.swapLogger.info(swap, "processPastSwap(state=BTC_SENT): swap claimed (detected from processPastSwap), address: "+swap.address);
                    this.unsubscribePayment(swap);
                    await this.removeSwapData(swap, ToBtcSwapState.CLAIMED);
                } else if(status===SwapCommitStatus.EXPIRED) {
                    this.swapLogger.warn(swap, "processPastSwap(state=BTC_SENT): swap expired, but bitcoin was probably already sent, txId: "+swap.txId+" address: "+swap.address);
                    this.unsubscribePayment(swap);
                    await this.removeSwapData(swap, ToBtcSwapState.REFUNDED);
                }
                return;
            }
        }

        if(swap.state===ToBtcSwapState.COMMITED || swap.state===ToBtcSwapState.BTC_SENDING || swap.state===ToBtcSwapState.BTC_SENT) {
            await this.processInitialized(swap);
            return;
        }
    }

    /**
     * Checks past swaps, deletes ones that are already expired.
     */
    protected async processPastSwaps() {
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

        for(let swap of queriedData) {
            await this.processPastSwap(swap);
        }
    }

    protected async processBtcTx(swap: ToBtcSwapAbs, tx: BtcTx): Promise<boolean> {
        tx.confirmations = tx.confirmations || 0;

        //Check transaction has enough confirmations
        const hasEnoughConfirmations = tx.confirmations>=swap.data.getConfirmations();
        if(!hasEnoughConfirmations) {
            return false;
        }

        this.swapLogger.debug(swap, "processBtcTx(): address: "+swap.address+" amount: "+swap.amount.toString(10)+" btcTx: "+tx);

        //Search for required transaction output (vout)
        const outputScript = bitcoin.address.toOutputScript(swap.address, this.config.bitcoinNetwork);
        const vout = tx.outs.find(e => new BN(e.value).eq(swap.amount) && Buffer.from(e.scriptPubKey.hex, "hex").equals(outputScript));
        if(vout==null) {
            this.swapLogger.warn(swap, "processBtcTx(): cannot find correct vout,"+
                " required output script: "+outputScript.toString("hex")+
                " required amount: "+swap.amount.toString(10)+
                " vouts: ", tx.outs);
            return false;
        }

        if(swap.metadata!=null) swap.metadata.times.payTxConfirmed = Date.now();

        const success = await this.tryClaimSwap(tx, swap, vout.n);

        return success;
    }

    /**
     * Checks active sent out bitcoin transactions
     */
    private async processBtcTxs() {
        const unsubscribeSwaps: ToBtcSwapAbs[] = [];

        for(let txId in this.activeSubscriptions) {
            const swap: ToBtcSwapAbs = this.activeSubscriptions[txId];
            //TODO: RBF the transaction if it's already taking too long to confirm
            try {
                let tx: BtcTx = await this.bitcoinRpc.getTransaction(txId);
                if(tx==null) continue;

                if(await this.processBtcTx(swap, tx)) {
                    this.swapLogger.info(swap, "processBtcTxs(): swap claimed successfully, txId: "+tx.txid+" address: "+swap.address);
                    unsubscribeSwaps.push(swap);
                }
            } catch (e) {
                this.swapLogger.error(swap, "processBtcTxs(): error processing btc transaction", e);
            }
        }

        unsubscribeSwaps.forEach(swap => {
            this.unsubscribePayment(swap);
        });
    }

    /**
     * Subscribes to and periodically checks txId used to send out funds for the swap for enough confirmations
     *
     * @param payment
     */
    protected subscribeToPayment(payment: ToBtcSwapAbs) {
        this.swapLogger.info(payment, "subscribeToPayment(): subscribing to swap, txId: "+payment.txId+" address: "+payment.address);
        this.activeSubscriptions[payment.txId] = payment;
    }

    protected unsubscribePayment(payment: ToBtcSwapAbs) {
        if(payment.txId!=null) {
            if(this.activeSubscriptions[payment.txId]!=null) {
                this.swapLogger.info(payment, "unsubscribePayment(): unsubscribing swap, txId: "+payment.txId+" address: "+payment.address);
                delete this.activeSubscriptions[payment.txId];
            }
        }
    }

    /**
     * Checks if expiry time on the swap leaves us enough room to send a transaction and for the transaction to confirm
     *
     * @param swap
     * @private
     * @throws DefinedRuntimeError will throw an error in case there isn't enough time for us to send a BTC payout tx
     */
    protected checkExpiresTooSoon(swap: ToBtcSwapAbs): void {
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));
        const tsDelta = swap.data.getExpiry().sub(currentTimestamp);
        const minRequiredCLTV = this.getExpiryFromCLTV(swap.preferedConfirmationTarget, swap.data.getConfirmations());
        const hasRequiredCLTVDelta = tsDelta.gte(minRequiredCLTV);
        if(!hasRequiredCLTVDelta) throw {
            code: 90001,
            msg: "TS delta too low",
            data: {
                required: minRequiredCLTV.toString(10),
                actual: tsDelta.toString(10)
            }
        }
    }

    /**
     * Checks if the actual fee for the swap is no higher than the quoted estimate
     *
     * @param quotedSatsPerVbyte
     * @param actualSatsPerVbyte
     * @private
     * @throws DefinedRuntimeError will throw an error in case the actual fee is higher than quoted fee
     */
    protected checkCalculatedTxFee(quotedSatsPerVbyte: BN, actualSatsPerVbyte: BN): void {
        const swapPaysEnoughNetworkFee = quotedSatsPerVbyte.gte(actualSatsPerVbyte);
        if(!swapPaysEnoughNetworkFee) throw {
            code: 90003,
            msg: "Fee changed too much!",
            data: {
                quotedFee: actualSatsPerVbyte.toString(10),
                actualFee: quotedSatsPerVbyte.toString(10)
            }
        };
    }

    /**
     * Runs sanity check on the calculated fee for the transaction
     *
     * @param psbt
     * @param tx
     * @param maxAllowedSatsPerVbyte
     * @param actualSatsPerVbyte
     * @private
     * @throws {Error} Will throw an error if the fee sanity check doesn't pass
     */
    protected checkPsbtFee(
        psbt: bitcoin.Psbt,
        tx: bitcoin.Transaction,
        maxAllowedSatsPerVbyte: BN,
        actualSatsPerVbyte: BN
    ): BN {
        const txFee = new BN(psbt.getFee());

        //Sanity check on sats/vB
        const maxAllowedFee = new BN(tx.virtualSize())
            //Considering the extra output was not added, because was detrminetal
            .add(new BN(utils.outputBytes({type: this.LND_CHANGE_OUTPUT_TYPE})))
            //Multiply by maximum allowed feerate
            .mul(maxAllowedSatsPerVbyte)
            //Possibility that extra output was not added due to it being lower than dust
            .add(new BN(utils.dustThreshold({type: this.LND_CHANGE_OUTPUT_TYPE})));

        if(txFee.gt(maxAllowedFee)) throw new Error("Generated tx fee too high: "+JSON.stringify({
            maxAllowedFee: maxAllowedFee.toString(10),
            actualFee: txFee.toString(10),
            psbtHex: psbt.toHex(),
            maxAllowedSatsPerVbyte: maxAllowedSatsPerVbyte.toString(10),
            actualSatsPerVbyte: actualSatsPerVbyte.toString(10)
        }));

        return txFee;
    }

    /**
     * Create PSBT for swap payout from coinselection result
     *
     * @param address
     * @param amount
     * @param escrowNonce
     * @param coinselectResult
     * @private
     */
    private async getPsbt(
        address: string,
        amount: BN,
        escrowNonce: BN,
        coinselectResult: {inputs: CoinselectTxInput[], outputs: CoinselectTxOutput[]}
    ): Promise<bitcoin.Psbt> {
        let psbt = new bitcoin.Psbt();

        //Apply nonce
        const nonceBuffer = Buffer.from(escrowNonce.toArray("be", 8));

        const locktimeBN = new BN(nonceBuffer.slice(0, 5), "be");
        let locktime = locktimeBN.toNumber() + 500000000;
        psbt.setLocktime(locktime);

        const sequenceBN = new BN(nonceBuffer.slice(5, 8), "be");
        const sequence = 0xFE000000 + sequenceBN.toNumber();
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
            script: bitcoin.address.toOutputScript(address, this.config.bitcoinNetwork),
            value: amount.toNumber()
        });

        //Add change output
        if(coinselectResult.outputs.length>1) psbt.addOutput({
            script: bitcoin.address.toOutputScript(await this.getChangeAddress(), this.config.bitcoinNetwork),
            value: coinselectResult.outputs[1].value
        });

        return psbt;
    }

    /**
     * Signs provided PSBT and also returns a raw signed transaction
     *
     * @param psbt
     * @private
     */
    protected async signPsbt(psbt: bitcoin.Psbt): Promise<{psbt: bitcoin.Psbt, rawTx: string}> {
        const signedPsbt = await lncli.signPsbt({
            lnd: this.LND,
            psbt: psbt.toHex()
        });
        return {
            psbt: bitcoin.Psbt.fromHex(signedPsbt.psbt),
            rawTx: signedPsbt.transaction
        };
    }

    /**
     * Sends raw bitcoin transaction
     *
     * @param rawTx
     * @private
     */
    protected async sendRawTransaction(rawTx: string): Promise<void> {
        await lncli.broadcastChainTransaction({
            lnd: this.LND,
            transaction: rawTx
        });
    }

    /**
     * Sends a bitcoin transaction to payout BTC for a swap
     *
     * @param swap
     * @private
     * @throws DefinedRuntimeError will throw an error in case the payment cannot be initiated
     */
    private sendBitcoinPayment(swap: ToBtcSwapAbs) {
        //Make sure that bitcoin payouts are processed sequentially to avoid race conditions between multiple payouts,
        // e.g. that 2 payouts share the same input and would effectively double-spend each other
        return this.sendBtcQueue.enqueue<void>(async () => {
            //Run checks
            this.checkExpiresTooSoon(swap);
            if(swap.metadata!=null) swap.metadata.times.payCLTVChecked = Date.now();

            const coinselectResult = await this.getChainFee(swap.address, swap.amount.toNumber());
            if(coinselectResult==null) throw {
                code: 90002,
                msg: "Failed to run coinselect algorithm (not enough funds?)"
            }
            if(swap.metadata!=null) swap.metadata.times.payChainFee = Date.now();

            this.checkCalculatedTxFee(swap.satsPerVbyte, coinselectResult.satsPerVbyte);

            //Construct payment PSBT
            let unsignedPsbt = await this.getPsbt(swap.address, swap.amount, swap.data.getEscrowNonce(), coinselectResult);
            this.swapLogger.debug(swap, "sendBitcoinPayment(): generated psbt: "+unsignedPsbt.toHex());

            //Sign the PSBT
            const {psbt, rawTx} = await this.signPsbt(unsignedPsbt);
            if(swap.metadata!=null) swap.metadata.times.paySignPSBT = Date.now();
            this.swapLogger.debug(swap, "sendBitcoinPayment(): signed raw transaction: "+rawTx);

            const tx = bitcoin.Transaction.fromHex(rawTx);
            const txFee = this.checkPsbtFee(psbt, tx, swap.satsPerVbyte, coinselectResult.satsPerVbyte);

            swap.txId = tx.getId();
            swap.setRealNetworkFee(txFee);
            await swap.setState(ToBtcSwapState.BTC_SENDING);
            await this.storageManager.saveData(swap.getHash(), swap.getSequence(), swap);

            await this.sendRawTransaction(rawTx);
            if(swap.metadata!=null) swap.metadata.times.payTxSent = Date.now();
            this.swapLogger.info(swap, "sendBitcoinPayment(): btc transaction generated, signed & broadcasted, txId: "+tx.getId()+" address: "+swap.address);
            //Invalidate the UTXO cache
            this.cachedUtxos = null;

            await swap.setState(ToBtcSwapState.BTC_SENT);
            await this.storageManager.saveData(swap.getHash(), swap.getSequence(), swap);
        });
    }

    /**
     * Called after swap was successfully committed, will check if bitcoin tx is already sent, if not tries to send it and subscribes to it
     *
     * @param swap
     */
    private async processInitialized(swap: ToBtcSwapAbs) {
        if(swap.state===ToBtcSwapState.BTC_SENDING) {
            //Bitcoin transaction was signed (maybe also sent)
            const tx = await this.bitcoinRpc.getTransaction(swap.txId);

            const isTxSent = tx!=null;
            if(!isTxSent) {
                //Reset the state to COMMITED
                this.swapLogger.info(swap, "processInitialized(state=BTC_SENDING): btc transaction not found, resetting to COMMITED state, txId: "+swap.txId+" address: "+swap.address);
                await swap.setState(ToBtcSwapState.COMMITED);
            } else {
                this.swapLogger.info(swap, "processInitialized(state=BTC_SENDING): btc transaction found, advancing to BTC_SENT state, txId: "+swap.txId+" address: "+swap.address);
                await swap.setState(ToBtcSwapState.BTC_SENT);
                await this.storageManager.saveData(swap.getHash(), swap.data.getSequence(), swap);
            }
        }

        if(swap.state===ToBtcSwapState.SAVED) {
            this.swapLogger.info(swap, "processInitialized(state=SAVED): advancing to COMMITED state, address: "+swap.address);
            await swap.setState(ToBtcSwapState.COMMITED);
            await this.storageManager.saveData(swap.getHash(), swap.data.getSequence(), swap);
        }

        if(swap.state===ToBtcSwapState.COMMITED) {
            const unlock: () => boolean = swap.lock(60);
            if(unlock==null) return;

            this.swapLogger.debug(swap, "processInitialized(state=COMMITED): sending bitcoin transaction, address: "+swap.address);

            try {
                await this.sendBitcoinPayment(swap);
                this.swapLogger.info(swap, "processInitialized(state=COMMITED): btc transaction sent, address: "+swap.address);
            } catch (e) {
                if(isDefinedRuntimeError(e)) {
                    this.swapLogger.error(swap, "processInitialized(state=COMMITED): setting state to NON_PAYABLE due to send bitcoin payment error", e);
                    if(swap.metadata!=null) swap.metadata.payError = e;
                    await swap.setState(ToBtcSwapState.NON_PAYABLE);
                    await this.storageManager.saveData(swap.getHash(), swap.data.getSequence(), swap);
                } else {
                    this.swapLogger.error(swap, "processInitialized(state=COMMITED): send bitcoin payment error", e);
                    throw e;
                }
            }

            unlock();
        }

        if(swap.state===ToBtcSwapState.NON_PAYABLE) return;

        this.subscribeToPayment(swap);
    }

    protected async processInitializeEvent(chainIdentifier: string, event: InitializeEvent<SwapData>): Promise<void> {
        if(event.swapType!==ChainSwapType.CHAIN_NONCED) return;

        const paymentHash = event.paymentHash;

        const swap = await this.storageManager.getData(paymentHash, event.sequence);
        if(swap==null || swap.chainIdentifier!==chainIdentifier) return;

        swap.txIds.init = (event as any).meta?.txId;
        if(swap.metadata!=null) swap.metadata.times.txReceived = Date.now();

        this.swapLogger.info(swap, "SC: InitializeEvent: swap initialized by the client, address: "+swap.address);

        await this.processInitialized(swap);
    }

    protected async processClaimEvent(chainIdentifier: string, event: ClaimEvent<SwapData>): Promise<void> {
        const paymentHash = event.paymentHash;

        const swap = await this.storageManager.getData(paymentHash, event.sequence);
        if(swap==null || swap.chainIdentifier!==chainIdentifier) return;

        swap.txIds.claim = (event as any).meta?.txId;

        this.swapLogger.info(swap, "SC: ClaimEvent: swap successfully claimed to us, address: "+swap.address);

        //Also remove transaction from active subscriptions
        this.unsubscribePayment(swap);
        await this.removeSwapData(swap, ToBtcSwapState.CLAIMED);
    }

    protected async processRefundEvent(chainIdentifier: string, event: RefundEvent<SwapData>): Promise<void> {
        const paymentHash = event.paymentHash;

        const swap = await this.storageManager.getData(paymentHash, event.sequence);
        if(swap==null || swap.chainIdentifier!==chainIdentifier) return;

        swap.txIds.refund = (event as any).meta?.txId;

        this.swapLogger.info(swap, "SC: RefundEvent: swap successfully refunded by the user, address: "+swap.address);

        //Also remove transaction from active subscriptions
        this.unsubscribePayment(swap);
        await this.removeSwapData(swap, ToBtcSwapState.REFUNDED);
    }

    /**
     * Returns required expiry delta for swap params
     *
     * @param confirmationTarget
     * @param confirmations
     */
    protected getExpiryFromCLTV(confirmationTarget: number, confirmations: number): BN {
        //Blocks = 10 + (confirmations + confirmationTarget)*2
        //Time = 3600 + (600*blocks*2)
        const cltv = this.config.minChainCltv.add(
            new BN(confirmations).add(new BN(confirmationTarget)).mul(this.config.sendSafetyFactor)
        );

        return this.config.gracePeriod.add(this.config.bitcoinBlocktime.mul(cltv).mul(this.config.safetyFactor));
    }

    /**
     * Checks if the requested nonce is valid
     *
     * @param nonce
     * @throws {DefinedRuntimeError} will throw an error if the nonce is invalid
     */
    private checkNonceValid(nonce: BN): void {
        if(nonce.isNeg() || nonce.gte(new BN(2).pow(new BN(64)))) throw {
            code: 20021,
            msg: "Invalid request body (nonce - cannot be parsed)"
        };

        const nonceBuffer = Buffer.from(nonce.toArray("be", 8));
        const firstPart = new BN(nonceBuffer.slice(0, 5), "be");

        const maxAllowedValue = new BN(Math.floor(Date.now()/1000)-600000000);
        if(firstPart.gt(maxAllowedValue)) throw {
            code: 20022,
            msg: "Invalid request body (nonce - too high)"
        };
    }

    /**
     * Checks if confirmation target is within configured bounds
     *
     * @param confirmationTarget
     * @throws {DefinedRuntimeError} will throw an error if the confirmationTarget is out of bounds
     */
    protected checkConfirmationTarget(confirmationTarget: number): void {
        if(confirmationTarget>this.config.maxConfTarget) throw {
            code: 20023,
            msg: "Invalid request body (confirmationTarget - too high)"
        };
        if(confirmationTarget<this.config.minConfTarget) throw {
            code: 20024,
            msg: "Invalid request body (confirmationTarget - too low)"
        };
    }

    /**
     * Checks if the required confirmations are within configured bounds
     *
     * @param confirmations
     * @throws {DefinedRuntimeError} will throw an error if the confirmations are out of bounds
     */
    protected checkRequiredConfirmations(confirmations: number): void {
        if(confirmations>this.config.maxConfirmations) throw {
            code: 20025,
            msg: "Invalid request body (confirmations - too high)"
        };
        if(confirmations<this.config.minConfirmations) throw {
            code: 20026,
            msg: "Invalid request body (confirmations - too low)"
        };
    }

    /**
     * Checks the validity of the provided address, also checks if the resulting output script isn't too large
     *
     * @param address
     * @throws {DefinedRuntimeError} will throw an error if the address is invalid
     */
    protected checkAddress(address: string): void {
        let parsedOutputScript: Buffer;

        try {
            parsedOutputScript = bitcoin.address.toOutputScript(address, this.config.bitcoinNetwork);
        } catch (e) {
            throw {
                code: 20031,
                msg: "Invalid request body (address - cannot be parsed)"
            };
        }

        if(parsedOutputScript.length > OUTPUT_SCRIPT_MAX_LENGTH) throw {
            code: 20032,
            msg: "Invalid request body (address's output script - too long)"
        };
    }

    /**
     * Checks if the swap is expired, taking into consideration on-chain time skew
     *
     * @param swap
     * @throws {DefinedRuntimeError} will throw an error if the swap is expired
     */
    protected checkExpired(swap: ToBtcSwapAbs) {
        const isExpired = swap.data.getExpiry().lt(new BN(Math.floor(Date.now()/1000)).sub(new BN(this.config.maxSkew)));
        if(isExpired) throw {
            _httpStatus: 200,
            code: 20010,
            msg: "Payment expired"
        };
    }

    /**
     * Checks & returns the network fee needed for a transaction
     *
     * @param address
     * @param amount
     * @throws {DefinedRuntimeError} will throw an error if there are not enough BTC funds
     */
    private async checkAndGetNetworkFee(address: string, amount: BN): Promise<{ networkFee: BN, satsPerVbyte: BN }> {
        let chainFeeResp = await this.getChainFee(address, amount.toNumber(), true, this.config.networkFeeMultiplierPPM);

        const hasEnoughFunds = chainFeeResp!=null;
        if(!hasEnoughFunds) throw {
            code: 20002,
            msg: "Not enough liquidity"
        };

        return chainFeeResp;
    }

    startRestServer(restServer: Express) {
        restServer.use(this.path+"/payInvoice", serverParamDecoder(10*1000));
        restServer.post(this.path+"/payInvoice", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {
                request: any,
                times: {[key: string]: number}
            } = {request: {}, times: {}};

            const chainIdentifier = req.query.chain as string ?? this.chains.default;
            const {swapContract, signer} = this.getChain(chainIdentifier);

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
                        this.isTokenSupported(chainIdentifier, val) ? val : null,
                offerer: (val: string) => val!=null &&
                        typeof(val)==="string" &&
                        swapContract.isValidAddress(val) ? val : null,
                exactIn: FieldTypeEnum.BooleanOptional
            });
            if (parsedBody==null) throw {
                code: 20100,
                msg: "Invalid request body"
            };
            metadata.request = parsedBody;

            const requestedAmount = {input: !!parsedBody.exactIn, amount: parsedBody.amount};
            const request = {
                chainIdentifier,
                raw: req,
                parsed: parsedBody,
                metadata
            };
            const useToken = parsedBody.token;

            const responseStream = res.responseStream;

            this.checkNonceValid(parsedBody.nonce);
            this.checkConfirmationTarget(parsedBody.confirmationTarget);
            this.checkRequiredConfirmations(parsedBody.confirmations);
            this.checkAddress(parsedBody.address);
            await this.checkVaultInitialized(chainIdentifier, parsedBody.token);
            const fees = await this.preCheckAmounts(request, requestedAmount, useToken);

            metadata.times.requestChecked = Date.now();

            //Initialize abort controller for the parallel async operations
            const abortController = this.getAbortController(responseStream);

            const {pricePrefetchPromise, signDataPrefetchPromise} = this.getToBtcPrefetches(chainIdentifier, useToken, responseStream, abortController);

            const {
                amountBD,
                networkFeeData,
                totalInToken,
                swapFee,
                swapFeeInToken,
                networkFeeInToken
            } = await this.checkToBtcAmount(request, requestedAmount, fees, useToken, async (amount: BN) => {
                metadata.times.amountsChecked = Date.now();
                const resp = await this.checkAndGetNetworkFee(parsedBody.address, amount);
                metadata.times.chainFeeCalculated = Date.now();
                return resp;
            }, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            const paymentHash = this.getHash(chainIdentifier, parsedBody.address, parsedBody.nonce, amountBD, this.config.bitcoinNetwork).toString("hex");

            //Add grace period another time, so the user has 1 hour to commit
            const expirySeconds = this.getExpiryFromCLTV(parsedBody.confirmationTarget, parsedBody.confirmations).add(new BN(this.config.gracePeriod));
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const minRequiredExpiry = currentTimestamp.add(expirySeconds);

            const sequence = new BN(randomBytes(8));
            const payObject: SwapData = await swapContract.createSwapData(
                ChainSwapType.CHAIN_NONCED,
                parsedBody.offerer,
                signer.getAddress(),
                useToken,
                totalInToken,
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

            const sigData = await this.getToBtcSignatureData(chainIdentifier, payObject, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcSwapAbs(
                chainIdentifier,
                parsedBody.address,
                amountBD,
                swapFee,
                swapFeeInToken,
                networkFeeData.networkFee,
                networkFeeInToken,
                networkFeeData.satsPerVbyte,
                parsedBody.nonce,
                parsedBody.confirmationTarget,
                new BN(sigData.timeout)
            );
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(paymentHash, sequence, createdSwap);

            this.swapLogger.info(createdSwap, "REST: /payInvoice: created swap address: "+createdSwap.address+" amount: "+amountBD.toString(10));

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    address: signer.getAddress(),
                    satsPervByte: networkFeeData.satsPerVbyte.toString(10),
                    networkFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    totalFee: swapFeeInToken.add(networkFeeInToken).toString(10),
                    total: totalInToken.toString(10),
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
            if (parsedBody==null) throw {
                code: 20100,
                msg: "Invalid request body/query (paymentHash/sequence)"
            };

            this.checkSequence(parsedBody.sequence);

            const payment = await this.storageManager.getData(parsedBody.paymentHash, parsedBody.sequence);
            if (payment == null || payment.state === ToBtcSwapState.SAVED) throw {
                _httpStatus: 200,
                code: 20007,
                msg: "Payment not found"
            };

            const {swapContract, signer} = this.getChain(payment.chainIdentifier);

            this.checkExpired(payment);

            if (payment.state === ToBtcSwapState.COMMITED) throw {
                _httpStatus: 200,
                code: 20008,
                msg: "Payment processing"
            };

            if (payment.state === ToBtcSwapState.BTC_SENT || payment.state===ToBtcSwapState.BTC_SENDING) throw {
                _httpStatus: 200,
                code: 20006,
                msg: "Already paid",
                data: {
                    txId: payment.txId
                }
            };

            if (payment.state === ToBtcSwapState.NON_PAYABLE) {
                const isCommited = await swapContract.isCommited(payment.data);
                if (!isCommited) throw {
                    code: 20005,
                    msg: "Not committed"
                };

                const refundResponse = await swapContract.getRefundSignature(signer, payment.data, this.config.authorizationTimeout);

                //Double check the state after promise result
                if (payment.state !== ToBtcSwapState.NON_PAYABLE) throw {
                    code: 20005,
                    msg: "Not committed"
                };

                this.swapLogger.info(payment, "REST: /getRefundAuthorization: returning refund authorization, because swap is in NON_PAYABLE state, address: "+payment.address);

                res.status(200).json({
                    code: 20000,
                    msg: "Success",
                    data: {
                        address: signer.getAddress(),
                        prefix: refundResponse.prefix,
                        timeout: refundResponse.timeout,
                        signature: refundResponse.signature
                    }
                });
                return;
            }

            throw {
                _httpStatus: 500,
                code: 20009,
                msg: "Invalid payment status"
            };
        });

        restServer.post(this.path+"/getRefundAuthorization", getRefundAuthorization);
        restServer.get(this.path+"/getRefundAuthorization", getRefundAuthorization);

        this.logger.info("started at path: ", this.path);
    }

    /**
     * Starts watchdog checking sent bitcoin transactions
     */
    protected async startTxTimer() {
        let rerun;
        rerun = async () => {
            await this.processBtcTxs().catch( e => this.logger.error("startTxTimer(): call to processBtcTxs() errored", e));
            setTimeout(rerun, this.config.txCheckInterval);
        };
        await rerun();
    }

    async startWatchdog() {
        await super.startWatchdog();
        await this.startTxTimer();
    }

    async init() {
        await this.storageManager.loadData(ToBtcSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    getInfoData(): any {
        return {
            minCltv: this.config.minChainCltv.toNumber(),

            minConfirmations: this.config.minConfirmations,
            maxConfirmations: this.config.maxConfirmations,

            minConfTarget: this.config.minConfTarget,
            maxConfTarget: this.config.maxConfTarget,

            maxOutputScriptLen: OUTPUT_SCRIPT_MAX_LENGTH
        };
    }

}
