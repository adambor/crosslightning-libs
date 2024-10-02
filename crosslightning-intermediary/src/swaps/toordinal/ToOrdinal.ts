import {ChainSwapType, SwapData} from "crosslightning-base";
import {ToBtcAbs, ToBtcRequestType} from "../tobtc_abstract/ToBtcAbs";
import {serverParamDecoder} from "../../utils/paramcoders/server/ServerParamDecoder";
import {expressHandlerWrapper, HEX_REGEX} from "../../utils/Utils";
import {IParamReader} from "../../utils/paramcoders/IParamReader";
import {ServerParamEncoder} from "../../utils/paramcoders/server/ServerParamEncoder";
import {FieldTypeEnum, verifySchema} from "../../utils/paramcoders/SchemaVerifier";
import * as BN from "bn.js";
import {randomBytes} from "crypto";
import {ToBtcSwapAbs, ToBtcSwapState} from "../tobtc_abstract/ToBtcSwapAbs";
import {PluginManager} from "../../plugins/PluginManager";
import {Express} from "express";
import {Psbt, Transaction} from "bitcoinjs-lib";
import * as secp256k1 from "@bitcoinerlab/secp256k1";
import {CoinselectTxInput, CoinselectTxOutput} from "../../utils/coinselect2/utils";
import {coinSelect} from "../../utils/coinselect2";
import * as bitcoin from "bitcoinjs-lib";
import * as lncli from "ln-service";
import {ToOrdinalSwap} from "./ToOrdinalSwap";

const signatureValidator = (
    pubkey: Uint8Array,
    msghash: Uint8Array,
    signature: Uint8Array,
): boolean => {
    if(pubkey.length===32) return secp256k1.verifySchnorr(msghash, pubkey, signature);
    return secp256k1.verify(msghash, pubkey, signature);
};

export type ToOrdinalRequestType = {
    address: string,
    psbt: string,
    confirmationTarget: number,
    confirmations: number,
    token: string,
    offerer: string
};

/**
 * A smart-chain to bitcoin ordinal swap handler
 *
 * 1. Client sends his btc address and an ordinal sell psbt, basically a 1-input & 1-output bitcoin transaction signed
 *  by seller with SIGHASH_SINGLE | ANYONECANPAY, such that the input is the ordinal & output is the price, e.g.
 *  ---> Ordinal sats input (1000 sats) ---|--- Seller's address output (x sats) --->
 *
 * 2. Intermediary constructs a valid ordinal buy PSBT (with required offsets), funding the transaction with his own
 *  funds & sending the ordinal to the client's btc address, e.g. (size ~600vB)
 *  ---> Offset input (600 sats) -----------|--- Offset output (1200 sats)
 *  ---> Offset input (600 sats) -----------|--- Client's address output (1000 sats)
 *  ---> Ordinal sats input (1000 sats) ----|--- Seller's address output (x sats)
 *  ---> Prior offset output (1200 sats) ---|--- Next offset input (600 sats)
 *  ---> Intermediary UTXOs (y sats) -------|--- Next offset input (600 sats)
 *                                          |--- Intermediary change outputs (x-y-fees sats)
 *
 * 3. Intermediary creates SwapData initializing the PTLC, that is locked by the txId of the ordinal buy PSBT.
 * 4. Intermediary sends the unsigned PSBT & SwapData to the client
 * 5. Client checks that the ordinal buy PSBT is correctly constructed & it's txId matches the one specified in SwapData
 * 6. Client commits the PTLC on the smart chain side, locking the funds inside
 * 7. Intermediary signs the ordinal buy PSBT & broadcasts it to the network
 * 8. Intermediary is able to claim funds from the PTLC As soon as the ordinal buy transaction confirms
 */
export class ToOrdinal<T extends SwapData> extends ToBtcAbs<T> {

    static readonly OFFSET_VALUE = 330;
    protected changeAddress: string;
    protected changeAddressScript: Buffer;

    /**
     * Checks ordinal sale PSBT
     *
     * @param psbtHexString
     * @private
     * @throws {DefinedRuntimeError} If the psbt cannot be parsed, has invalid format or invalid signature
     * @returns parsed PSBT object
     */
    private async checkSalePsbt(psbtHexString: string): Promise<Psbt> {
        let psbt: Psbt;
        try {
            psbt = Psbt.fromHex(psbtHexString);
        } catch (e) {
            this.logger.error("checkSalePsbt(): Psbt parse error: ", e);
        }
        if(psbt==null) throw {
            code: 80000,
            msg: "PSBT cannot be parsed!"
        };
        if(psbt.txInputs.length!==1 && psbt.txOutputs.length!==1) throw {
            code: 80001,
            msg: "Invalid PSBT, need to have exactly 1 input & 1 output!"
        }
        const input = psbt.txInputs[0];
        if(input.hash==null || input.index==null || input.sequence==null) throw {
            code: 80002,
            msg: "Invalid PSBT, invalid input!"
        };
        const output = psbt.txOutputs[0];
        if(output.value==null || isNaN(output.value) || output.script==null) throw {
            code: 80003,
            msg: "Invalid PSBT, invalid output!"
        };
        const transaction = await this.bitcoinRpc.getTransaction(input.hash.reverse().toString("hex"));
        if(transaction==null) throw {
            code: 80005,
            msg: "Invalid PSBT, invalid input reference txId!"
        }
        const transactionOutput = transaction.outs[input.index];
        if(transactionOutput==null) throw {
            code: 80006,
            msg: "Invalid PSBT, invalid input reference vout!"
        }
        psbt.data.inputs[0].witnessUtxo = {
            value: transactionOutput.value,
            script: Buffer.from(transactionOutput.scriptPubKey.hex, "hex")
        };
        psbt.data.inputs[0].nonWitnessUtxo = Buffer.from(transaction.hex, "hex");
        if(!psbt.validateSignaturesOfInput(0, signatureValidator)) throw {
            code: 80004,
            msg: "Invalid PSBT, invalid input signature!"
        };
        return psbt;
    }

    private toInputAndOutput(psbt: Psbt): {
        input: CoinselectTxInput,
        output: CoinselectTxOutput
    } {
        const inputFinalized = psbt.clone().finalizeInput(0).data.inputs[0];
        const input = psbt.txInputs[0];
        const output = psbt.txOutputs[0];

        return {
            input: {
                script: inputFinalized.finalScriptSig,
                witness: inputFinalized.finalScriptWitness,
                txId: input.hash.reverse().toString("hex"),
                vout: input.index,
                value: inputFinalized.witnessUtxo ?
                    inputFinalized.witnessUtxo.value :
                    Transaction.fromBuffer(inputFinalized.nonWitnessUtxo).outs[input.index].value
            },
            output: {
                value: output.value,
                script: output.script
            }
        };
    }

    private getTxId(psbt: Psbt): string {
        return ((psbt as any).__CACHE.__TX as Transaction).getId();
    }

    private toPsbt(inputs: CoinselectTxInput[], outputs: CoinselectTxOutput[], salePsbt: Psbt): Psbt {
        const psbt = new Psbt({network: this.config.bitcoinNetwork});
        psbt.addInputs(inputs.map(input => {
            return {
                hash: input.txId,
                index: input.vout,
                witnessUtxo: {
                    script: input.outputScript,
                    value: input.value
                },
                sighashType: 0x01
            };
        }));
        psbt.addOutputs(outputs.map(output => {
            return {
                script: output.script,
                value: output.value
            };
        }));
        psbt.updateInput(2, salePsbt.data.inputs[0]);
        return psbt;
    }

    /**
     * Computes bitcoin on-chain network fee, takes channel reserve & network fee multiplier into consideration
     *
     * @param targetAddress
     * @param targetAmount
     * @private
     * @returns Fee estimate & inputs/outputs to use when constructing transaction, or null in case of not enough funds
     */
    private async _getChainFee(salePsbt: Psbt, targetAddress: string): Promise<{
        satsPerVbyte: number,
        fee: number,
        psbt: Psbt,
        txId: string
    } | null> {
        let satsPerVbyte: number | null = this.config.feeEstimator==null
            ? await lncli.getChainFeeRate({lnd: this.LND})
                .then(res => res.tokens_per_vbyte)
                .catch(e => this.logger.error("getChainFee(): LND getChainFeeRate error", e))
            : await this.config.feeEstimator.estimateFee();

        if(satsPerVbyte==null) return null;

        const unfilteredUtxoPool = await this.getUtxoPool();
        const utxoPool = unfilteredUtxoPool.filter(utxo => utxo.confirmations>=this.CONFIRMATIONS_REQUIRED);

        const offsetUtxos: CoinselectTxInput[] = [];
        const offsetOutputUtxos: CoinselectTxInput[] = [];
        const restUtxos: CoinselectTxInput[] = [];
        utxoPool.forEach(utxo => {
            switch(utxo.value) {
                case ToOrdinal.OFFSET_VALUE:
                    offsetUtxos.push(utxo);
                    break;
                case 2*ToOrdinal.OFFSET_VALUE:
                    offsetOutputUtxos.push(utxo);
                    break;
                default:
                    restUtxos.push(utxo);
            }
        })

        if(offsetUtxos.length<2) return null;
        let shouldIncludeOutputOffset = offsetOutputUtxos.length>0;

        const {input, output} = this.toInputAndOutput(salePsbt);

        const requiredInputs: CoinselectTxInput[] = offsetUtxos.slice(0, 2);
        requiredInputs.push(input);
        if(shouldIncludeOutputOffset) requiredInputs.push(offsetOutputUtxos[0]);

        const outputs: CoinselectTxOutput[] = [
            {
                value: 2*ToOrdinal.OFFSET_VALUE,
                address: this.changeAddress,
                script: this.changeAddressScript
            },
            {
                address: targetAddress,
                value: input.value,
                script: bitcoin.address.toOutputScript(targetAddress, this.config.bitcoinNetwork)
            },
            output
        ];
        if(shouldIncludeOutputOffset) {
            outputs.push({
                value: ToOrdinal.OFFSET_VALUE,
                address: this.changeAddress,
                script: this.changeAddressScript
            }, {
                value: ToOrdinal.OFFSET_VALUE,
                address: this.changeAddress,
                script: this.changeAddressScript
            });
        }
        const initialOutputLength = outputs.length;

        let obj = coinSelect(restUtxos, outputs, satsPerVbyte, this.LND_CHANGE_OUTPUT_TYPE, requiredInputs, true);

        if(obj.inputs==null || obj.outputs==null) return null;

        if(obj.outputs.length>initialOutputLength) {
            const changeOutput = obj.outputs[obj.outputs.length-1];
            changeOutput.address = this.changeAddress;
            changeOutput.script = this.changeAddressScript;
        }

        if(!await this.isLeavingEnoughForLightningAnchors(restUtxos, obj, satsPerVbyte, initialOutputLength)) return null;

        this.logger.info("getChainFee(): fee estimated,"+
            " target: "+targetAddress+
            " amount: "+output.value+
            " fee: "+obj.fee+
            " sats/vB: "+satsPerVbyte+
            " inputs: "+obj.inputs.length+
            " outputs: "+obj.outputs.length);

        const psbt = this.toPsbt(obj.inputs, obj.outputs, salePsbt);

        return {
            fee: obj.fee,
            satsPerVbyte,
            psbt,
            txId: this.getTxId(psbt)
        };
    }

    /**
     * Checks & returns the network fee needed for a transaction
     *
     * @param address
     * @param amount
     * @throws {DefinedRuntimeError} will throw an error if there are not enough BTC funds
     */
    private async _checkAndGetNetworkFee(psbt: Psbt, targetAddress: string): Promise<{
        networkFee: BN,
        satsPerVbyte: BN,
        psbt: Psbt,
        txId: string
    }> {
        let chainFeeResp = await this._getChainFee(psbt, targetAddress);

        const hasEnoughFunds = chainFeeResp!=null;
        if(!hasEnoughFunds) throw {
            code: 20002,
            msg: "Not enough liquidity"
        };

        const multiplier = this.config.networkFeeMultiplierPPM.toNumber()/1000000;

        const networkFee = new BN(chainFeeResp.fee);
        const satsPerVbyte = new BN(Math.ceil(chainFeeResp.satsPerVbyte*multiplier));

        this.logger.debug("checkAndGetNetworkFee(): adjusted sats/vB: "+satsPerVbyte.toString(10));

        return { networkFee, satsPerVbyte, psbt: chainFeeResp.psbt, txId: chainFeeResp.txId };
    }

    /**
     * Checks if the request should be processed by calling plugins
     *
     * @param req
     * @param parsedBody
     * @param metadata
     * @throws {DefinedRuntimeError} will throw an error if the plugin cancelled the request
     */
    private async _checkPlugins(req: Request & {paramReader: IParamReader}, parsedBody: ToOrdinalRequestType, metadata: any): Promise<{baseFee: BN, feePPM: BN}> {
        //TODO: Add to ordinal handler to plugins
        const pluginResult = {baseFee: null, feePPM: null, throw: null};

        if(pluginResult.throw) throw {
            code: 29999,
            msg: pluginResult.throw
        };

        return {
            baseFee: pluginResult.baseFee || this.config.baseFee,
            feePPM: pluginResult.feePPM || this.config.feePPM
        };
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
             * address: string                      Ordinal destination address
             * psbt: string                         Hex encoded ordinal sell PSBT signed by seller
             * confirmationTarget: number           Desired confirmation target for the swap, how big of a fee should be assigned to TX
             * confirmations: number                Required number of confirmations for us to claim the swap
             * token: string                        Desired token to use
             * offerer: string                      Address of the caller
             *
             *Sent later:
             * feeRate: string                      Fee rate to use for the init signature
             */
            const parsedBody: ToOrdinalRequestType = await req.paramReader.getParams({
                address: FieldTypeEnum.String,
                psbt: FieldTypeEnum.String,
                confirmationTarget: FieldTypeEnum.Number,
                confirmations: FieldTypeEnum.Number,
                token: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    this.allowedTokens.has(val) ? val : null,
                offerer: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    this.swapContract.isValidAddress(val) ? val : null
            });
            if (parsedBody==null) throw {
                code: 20100,
                msg: "Invalid request body"
            };
            metadata.request = parsedBody;

            const responseStream = res.responseStream;

            this.checkConfirmationTarget(parsedBody.confirmationTarget);
            this.checkRequiredConfirmations(parsedBody.confirmations);
            this.checkAddress(parsedBody.address);
            const psbt = await this.checkSalePsbt(parsedBody.psbt);
            await this.checkVaultInitialized(parsedBody.token);
            const {baseFee, feePPM} = await this._checkPlugins(req, parsedBody, metadata);

            metadata.times.requestChecked = Date.now();

            //Initialize abort controller for the parallel async operations
            const abortController = this.getAbortController(responseStream);

            const useToken = this.swapContract.toTokenAddress(parsedBody.token);

            const {pricePrefetchPromise, signDataPrefetchPromise} = this.getToBtcPrefetches(useToken, responseStream, abortController);

            const amount = new BN(psbt.txOutputs[0].value);

            const {
                amountBD,
                networkFeeData,
                totalInToken,
                swapFee,
                swapFeeInToken,
                networkFeeInToken
            } = await this.checkToBtcAmount(false, amount, useToken, {baseFee, feePPM}, async () => {
                metadata.times.amountsChecked = Date.now();
                const resp = await this._checkAndGetNetworkFee(psbt, parsedBody.address);
                metadata.times.chainFeeCalculated = Date.now();
                return resp;
            }, abortController.signal, pricePrefetchPromise);
            metadata.times.priceCalculated = Date.now();

            //Add grace period another time, so the user has 1 hour to commit
            const expirySeconds = this.getExpiryFromCLTV(parsedBody.confirmationTarget, parsedBody.confirmations).add(new BN(this.config.gracePeriod));
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const minRequiredExpiry = currentTimestamp.add(expirySeconds);

            const sequence = new BN(randomBytes(8));
            const payObject: T = await this.swapContract.createSwapData(
                ChainSwapType.CHAIN_TXID,
                parsedBody.offerer,
                this.swapContract.getAddress(),
                useToken,
                totalInToken,
                networkFeeData.txId,
                sequence,
                minRequiredExpiry,
                new BN(0),
                parsedBody.confirmations,
                true,
                false,
                new BN(0),
                new BN(0)
            );
            abortController.signal.throwIfAborted();
            metadata.times.swapCreated = Date.now();

            const sigData = await this.getToBtcSignatureData(payObject, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToOrdinalSwap<T>(parsedBody.address, amountBD, swapFee, networkFeeData.networkFee, networkFeeData.satsPerVbyte, new BN(0), parsedBody.confirmationTarget, new BN(sigData.timeout), networkFeeData.psbt);
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;

            await PluginManager.swapCreate(createdSwap);
            await this.storageManager.saveData(networkFeeData.txId, sequence, createdSwap);

            this.swapLogger.info(createdSwap, "REST: /payInvoice: created swap address: "+createdSwap.address+" amount: "+amountBD.toString(10));

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    amount: amountBD.toString(10),
                    address: this.swapContract.getAddress(),
                    satsPervByte: networkFeeData.satsPerVbyte.toString(10),
                    networkFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    totalFee: swapFeeInToken.add(networkFeeInToken).toString(10),
                    total: totalInToken.toString(10),
                    minRequiredExpiry: minRequiredExpiry.toString(10),
                    psbt: networkFeeData.psbt.toHex(),
                    txId: networkFeeData.txId,

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
                const isCommited = await this.swapContract.isCommited(payment.data);
                if (!isCommited) throw {
                    code: 20005,
                    msg: "Not committed"
                };

                const refundResponse = await this.swapContract.getRefundSignature(payment.data, this.config.authorizationTimeout);

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
                        address: this.swapContract.getAddress(),
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

    async init() {
        this.changeAddress = await this.getChangeAddress();
        this.changeAddressScript = bitcoin.address.toOutputScript(this.changeAddress, this.config.bitcoinNetwork);
        await super.init();
    }

}