import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import {Response} from "cross-fetch";
import {createHash, randomBytes} from "crypto-browserify";
import * as bolt11 from "bolt11";
import {ChainUtils, BitcoinTransaction} from "../btc/ChainUtils";
import {UserError} from "../errors/UserError";
import {IntermediaryError} from "../errors/IntermediaryError";
import {ISwapPrice} from "./ISwapPrice";
import {ChainSwapType, SignatureVerificationError, SwapCommitStatus, SwapContract, SwapData, TokenAddress} from "crosslightning-base";
import {BitcoinRpc, BtcRelay} from "crosslightning-base/dist";
import {
    findlnurl,
    getParams,
    LNURLPayParams,
    LNURLPaySuccessAction,
    LNURLWithdrawParams
} from "js-lnurl/lib";
import {RequestError} from "../errors/RequestError";
import {AbortError} from "../errors/AbortError";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {PriceInfoType} from "./ISwap";
import {PaymentRequestObject} from "bolt11";
import {TagsObject} from "bolt11";
import {
    FieldTypeEnum,
    RequestSchema,
    RequestSchemaResult,
    verifySchema
} from "../utils/paramcoders/SchemaVerifier";
import {RequestBody, streamingFetchWithTimeoutPromise} from "../utils/paramcoders/client/StreamingFetchPromise";

export class PaymentAuthError extends Error {

    code: number;
    data: any;

    constructor(msg: string, code?: number, data?: any) {
        super(msg);
        this.data = data;
        this.code = code;
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, PaymentAuthError.prototype);
    }

    getCode(): number {
        return this.code;
    }

    getData(): any {
        return this.data;
    }

}

const timeoutPromise = (timeoutSeconds) => {
    return new Promise(resolve => {
        setTimeout(resolve, timeoutSeconds*1000)
    });
};

export type ClientSwapContractOptions = {
    safetyFactor?: number,
    blocksTillTxConfirms?: number,
    maxConfirmations?: number,
    minSendWindow?: number,
    bitcoinNetwork?: bitcoin.networks.Network,

    lightningBaseFee?: number,
    lightningFeePPM?: number,

    bitcoinBlocktime?: number,

    maxExpectedOnchainSendSafetyFactor?: number,
    maxExpectedOnchainSendGracePeriodBlocks?: number,

    getRequestTimeout?: number,
    postRequestTimeout?: number
}

export type LNURLWithdrawParamsWithUrl = LNURLWithdrawParams & {url: string};
export type LNURLPayParamsWithUrl = LNURLPayParams & {url: string};

const BITCOIN_BLOCKTIME = 10*60;

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type LNURLPay = {
    type: "pay",
    min: BN,
    max: BN,
    commentMaxLength: number,
    shortDescription: string,
    longDescription?: string,
    icon?: string,
    params: LNURLPayParamsWithUrl
}

export type LNURLWithdraw= {
    type: "withdraw",
    min: BN,
    max: BN,
    params: LNURLWithdrawParamsWithUrl
}

export const MAIL_REGEX = /(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export class ClientSwapContract<T extends SwapData> {

    readonly btcRpc: BitcoinRpc<any>;
    readonly btcRelay: BtcRelay<any, any, any>;

    readonly swapDataDeserializer: new (data: any) => T;
    readonly swapContract: SwapContract<T, any, any, any>;
    readonly WBTC_ADDRESS: TokenAddress;
    readonly swapPrice: ISwapPrice;

    readonly options: ClientSwapContractOptions;

    constructor(
        swapContract: SwapContract<T, any, any, any>,
        swapDataDeserializer: new (data: any) => T,
        btcRelay: BtcRelay<any, any, any>,
        btcRpc: BitcoinRpc<any>,
        wbtcAddress?: TokenAddress,
        swapPrice?: ISwapPrice,
        options?: ClientSwapContractOptions
    ) {
        this.btcRpc = btcRpc;
        this.btcRelay = btcRelay;
        this.swapContract = swapContract;
        this.swapDataDeserializer = swapDataDeserializer;
        this.WBTC_ADDRESS = wbtcAddress;
        this.swapPrice = swapPrice;

        this.options = options;
        if(options==null) {
            this.options = {};
        }
        this.options.bitcoinNetwork = options.bitcoinNetwork || bitcoin.networks.testnet;
        this.options.safetyFactor = options.safetyFactor || 2;
        this.options.blocksTillTxConfirms = options.blocksTillTxConfirms || 12;
        this.options.maxConfirmations = options.maxConfirmations || 6;
        this.options.minSendWindow = options.minSendWindow || 30*60; //Minimum time window for user to send in the on-chain funds for From BTC swap
        this.options.lightningBaseFee = options.lightningBaseFee || 10;
        this.options.lightningFeePPM = options.lightningFeePPM || 2000;
        this.options.bitcoinBlocktime = options.bitcoinBlocktime|| (60*10);
        this.options.maxExpectedOnchainSendSafetyFactor = options.maxExpectedOnchainSendSafetyFactor || 4;
        this.options.maxExpectedOnchainSendGracePeriodBlocks = options.maxExpectedOnchainSendGracePeriodBlocks || 12;
    }

    private verifyReturnedSignature(
        data: T,
        parsedData: {
            timeout: string,
            prefix: string,
            signature: string
        },
        feeRatePromise?: Promise<any>,
        preFetchSignatureVerificationData?: Promise<any>,
        abortSignal?: AbortSignal
    ): Promise<void> {
        if(feeRatePromise==null) feeRatePromise = Promise.resolve(null);
        if(preFetchSignatureVerificationData==null) preFetchSignatureVerificationData = Promise.resolve(null);
        return tryWithRetries(
            () => Promise.all([feeRatePromise, preFetchSignatureVerificationData]).then(([feeRate, preFetchedData]) =>
                data.isPayIn() ?
                    this.swapContract.isValidClaimInitAuthorization(data, parsedData.timeout, parsedData.prefix, parsedData.signature, feeRate, preFetchedData) :
                    this.swapContract.isValidInitAuthorization(data, parsedData.timeout, parsedData.prefix, parsedData.signature, feeRate, preFetchedData)
            ),
            null,
            e => e instanceof SignatureVerificationError,
            abortSignal
        ).then(() => null);
    }

    private async verifyReturnedPrice(
        send: boolean,
        data: {
            isToken: (token: TokenAddress) => boolean,
            getAmount: () => BN,
            getToken: () => TokenAddress
        },
        amount: BN,
        feeData: {
            swapFee: BN,
            networkFee?: BN,
            totalFee?: BN
        },
        requiredToken?: TokenAddress,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        pricePrefetchPromise?: Promise<BN>,
        abortSignal?: AbortSignal
    ): Promise<{
        isValid: boolean,
        differencePPM: BN,
        satsBaseFee: BN,
        feePPM: BN
    }> {
        if(this.WBTC_ADDRESS!=null) {
            if(!data.isToken(this.WBTC_ADDRESS)) {
                throw new IntermediaryError("Invalid data returned - token");
            }

            const total = send ? amount.add(feeData.totalFee) : amount.sub(feeData.swapFee);
            if(!data.getAmount().eq(total)) {
                throw new IntermediaryError("Invalid data returned - amount");
            }
        } else {
            if(requiredToken!=null) if(!data.isToken(requiredToken)) {
                throw new IntermediaryError("Invalid data returned - token");
            }
            if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                const prefetchedPrice: BN = pricePrefetchPromise==null ? null : await pricePrefetchPromise;
                const isValidAmount = await (
                    send ?
                        this.swapPrice.isValidAmountSend(amount, requiredBaseFee, requiredFeePPM, data.getAmount().sub(feeData.networkFee), data.getToken(), abortSignal, prefetchedPrice) :
                        this.swapPrice.isValidAmountReceive(amount, requiredBaseFee, requiredFeePPM, data.getAmount(), data.getToken(), abortSignal, prefetchedPrice)
                );
                if(!isValidAmount.isValid) {
                    throw new IntermediaryError("Fee too high");
                }
                return isValidAmount;
            }
        }
    }

    private async postWithRetries<T extends RequestSchema>(url: string, body: RequestBody, dataSchema: T, signal: AbortSignal, doPrefetchData: boolean): Promise<{
        parsedData: RequestSchemaResult<T>,
        preFetchSignatureVerificationData: Promise<any>
    }> {
        const {response, jsonBody, preFetchSignatureVerificationData} = await tryWithRetries(async () => {
            const {response, responseBody} = await streamingFetchWithTimeoutPromise(url, body, {
                code: FieldTypeEnum.Number,
                msg: FieldTypeEnum.String,
                data: FieldTypeEnum.AnyOptional,

                ...(doPrefetchData && this.swapContract.preFetchForInitSignatureVerification!=null ?
                    {signDataPrefetch: FieldTypeEnum.AnyOptional} :{})
            }, this.options.postRequestTimeout, signal);

            if(response.status!==200) return {
                response
            };

            let _preFetchSignatureVerificationData: Promise<any> = null;
            if(doPrefetchData) {
                if(this.swapContract.preFetchForInitSignatureVerification!=null) {
                    _preFetchSignatureVerificationData = responseBody.signDataPrefetch.then(obj => {
                        if(obj==null) return null;
                        return (this.swapContract as any).preFetchForInitSignatureVerification(obj);
                    }).catch(e => {
                        console.error(e);
                        return null;
                    });
                } else {
                    _preFetchSignatureVerificationData = Promise.resolve(null);
                }
            }

            const [
                code,
                msg,
                data
            ] = await Promise.all([
                responseBody.code,
                responseBody.msg,
                responseBody.data.catch(e => null)
            ]);

            const jsonBody = {
                code,
                msg,
                data
            };

            return {
                response,
                jsonBody,
                preFetchSignatureVerificationData: _preFetchSignatureVerificationData
            }
        }, null, null, signal);

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw new RequestError(resp, response.status);
        }

        if(jsonBody.code!==20000) {
            throw RequestError.parse(JSON.stringify(jsonBody), 400);
        }

        const parsedData = verifySchema(jsonBody.data, dataSchema);

        return {
            parsedData,
            preFetchSignatureVerificationData
        }

    }

    getOnchainSendTimeout(data: SwapData): BN {
        const tsDelta = (this.options.blocksTillTxConfirms + data.getConfirmations()) * BITCOIN_BLOCKTIME * this.options.safetyFactor;
        return data.getExpiry().sub(new BN(tsDelta));
    }

    init(): Promise<void> {
        return this.swapContract.start();
    }

    isBareLNURL(str: string): boolean {
        try {
            return str.startsWith("lnurlw://") || str.startsWith("lnurlp://");
        } catch(e) {}
        return false;
    }

    private async getLNURL(str: string, shouldRetry?: boolean) : Promise<LNURLPayParamsWithUrl | LNURLWithdrawParamsWithUrl | null> {

        if(shouldRetry==null) shouldRetry = true;

        let res: any;
        if(MAIL_REGEX.test(str)) {
            //lightning e-mail like address
            const arr = str.split("@");
            const username = arr[0];
            const domain = arr[1];
            let scheme = "https";
            if(domain.endsWith(".onion")) {
                scheme = "http";
            }

            let response: Response;
            if(shouldRetry) {
                response = await tryWithRetries(() => fetchWithTimeout(scheme+"://"+domain+"/.well-known/lnurlp/"+username, {
                    method: "GET",
                    timeout: this.options.getRequestTimeout
                }));
            } else {
                response = await fetchWithTimeout(scheme+"://"+domain+"/.well-known/lnurlp/"+username, {
                    method: "GET",
                    timeout: this.options.getRequestTimeout
                });
            }

            if(!response.ok) {
                let resp: string;
                try {
                    resp = await response.text();
                } catch (e) {
                    throw new RequestError(response.statusText, response.status);
                }
                throw new RequestError(resp, response.status);
            }

            let jsonBody: any = await response.json();

            if(jsonBody.status==="ERROR") {
                return null;
            }

            res = jsonBody;
            res.tag = "payRequest";
            try {
                res.decodedMetadata = JSON.parse(res.metadata)
            } catch (err) {
                res.decodedMetadata = []
            }
        } else if(this.isBareLNURL(str)) {
            //lightning e-mail like address
            const data = str.substring("lnurlw://".length);
            const httpUrl = new URL("http://"+data);

            let scheme = "https";
            if(httpUrl.hostname.endsWith(".onion")) {
                scheme = "http";
            }

            let response: Response;
            if(shouldRetry) {
                response = await tryWithRetries(() => fetchWithTimeout(scheme+"://"+data, {
                    method: "GET",
                    timeout: this.options.getRequestTimeout
                }));
            } else {
                response = await fetchWithTimeout(scheme+"://"+data, {
                    method: "GET",
                    timeout: this.options.getRequestTimeout
                });
            }

            if(!response.ok) {
                let resp: string;
                try {
                    resp = await response.text();
                } catch (e) {
                    throw new RequestError(response.statusText, response.status);
                }
                throw new RequestError(resp, response.status);
            }

            let jsonBody: any = await response.json();

            if(jsonBody.status==="ERROR") {
                return null;
            }

            res = jsonBody;
            try {
                res.decodedMetadata = JSON.parse(res.metadata)
            } catch (err) {
                res.decodedMetadata = []
            }
        } else {
            const lnurl = findlnurl(str);
            if(lnurl==null) return null;
            res = await getParams(lnurl);
        }

        res.url = str;

        return res;
    }

    isLNURL(str: string): boolean {
        return findlnurl(str)!=null || MAIL_REGEX.test(str) || this.isBareLNURL(str);
    }

    async getLNURLType(str: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null> {

        let res: any = await this.getLNURL(str, shouldRetry);

        if(res.tag==="payRequest") {
            const payRequest: LNURLPayParamsWithUrl = res;
            let shortDescription: string;
            let longDescription: string;
            let icon: string;
            payRequest.decodedMetadata.forEach(data => {
                 switch(data[0]) {
                     case "text/plain":
                         shortDescription = data[1];
                         break;
                     case "text/long-desc":
                         longDescription = data[1];
                         break;
                     case "image/png;base64":
                         icon = "data:"+data[0]+","+data[1];
                         break;
                     case "image/jpeg;base64":
                         icon = "data:"+data[0]+","+data[1];
                         break;
                 }
            });
            return {
                type: "pay",
                min: new BN(payRequest.minSendable).div(new BN(1000)),
                max: new BN(payRequest.maxSendable).div(new BN(1000)),
                commentMaxLength: payRequest.commentAllowed || 0,
                shortDescription,
                longDescription,
                icon,
                params: payRequest
            }
        }
        if(res.tag==="withdrawRequest") {
            const payRequest: LNURLWithdrawParamsWithUrl = res;
            return {
                type: "withdraw",
                min: new BN(payRequest.minWithdrawable).div(new BN(1000)),
                max: new BN(payRequest.maxWithdrawable).div(new BN(1000)),
                params: payRequest
            }
        }
        return null;
    }

    async payOnchain(
        address: string,
        amountOrTokens: BN,
        confirmationTarget: number,
        confirmations: number,
        url: string,
        requiredToken?: TokenAddress,
        requiredClaimerKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<{
        amount: BN,
        networkFee: BN,
        swapFee: BN,
        totalFee: BN,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        expiry: number,
        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {
        const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);

        const nonceBuffer = Buffer.concat([
            Buffer.from(firstPart.toArray("be", 5)),
            randomBytes(3)
        ]);

        const nonce = new BN(nonceBuffer, "be");

        let outputScript;
        try {
            outputScript = bitcoin.address.toOutputScript(address, this.options.bitcoinNetwork);
        } catch (e) {
            throw new UserError("Invalid address specified");
        }

        let hash: string;
        let amount: BN;

        if(!exactIn) {
            amount = amountOrTokens;

            hash = this.swapContract.getHashForOnchain(outputScript, amount, nonce).toString("hex");

            console.log("Generated hash: ", hash);

            //This shall never happen with the provided entropy
            // const payStatus = await tryWithRetries(() => this.swapContract.getPaymentHashStatus(hash));
            //
            // if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
            //     throw new UserError("Invoice already being paid for or paid");
            // }
        }

        const abortController = new AbortController();

        const pricePreFetchPromise = this.swapPrice.preFetchPrice==null || requiredToken==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal).catch(e => {
            console.error(e);
            return null;
        });

        const feeRatePromise: Promise<any> = this.swapContract.getInitPayInFeeRate==null || requiredClaimerKey==null || requiredToken==null
            ? null
            : tryWithRetries(() => this.swapContract.getInitPayInFeeRate(this.swapContract.getAddress(), requiredClaimerKey, requiredToken, hash));

        const {parsedData, preFetchSignatureVerificationData} = await this.postWithRetries(url+"/payInvoice", {
            ...additionalParams,
            address,
            amount: amountOrTokens.toString(10),
            confirmationTarget,
            confirmations,
            nonce: nonce.toString(10),
            token: requiredToken==null ? null : requiredToken.toString(),
            offerer: this.swapContract.getAddress(),
            exactIn,
            feeRate: feeRatePromise==null ? null : feeRatePromise.then(val => val==null ? null : val.toString())
        }, {
            amount: FieldTypeEnum.BN,
            address: FieldTypeEnum.String,
            satsPervByte: FieldTypeEnum.BN,
            networkFee: FieldTypeEnum.BN,
            swapFee: FieldTypeEnum.BN,
            totalFee: FieldTypeEnum.BN,
            total: FieldTypeEnum.BN,
            minRequiredExpiry: FieldTypeEnum.BN,

            data: FieldTypeEnum.Any,

            prefix: FieldTypeEnum.String,
            timeout: FieldTypeEnum.String,
            signature: FieldTypeEnum.String
        }, abortController.signal, true).catch(e => {
            if(!abortController.signal.aborted) abortController.abort(e);
            throw e;
        });

        const total: BN = parsedData.total;

        if(exactIn) {
            if(!total.eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid total returned");
            }
            amount = parsedData.amount;

            hash = this.swapContract.getHashForOnchain(outputScript, amount, nonce).toString("hex");

            console.log("Generated hash: ", hash);
        }

        const swapFee: BN = parsedData.swapFee;
        const networkFee: BN = parsedData.networkFee;
        const totalFee: BN = parsedData.totalFee;

        if(!totalFee.eq(swapFee.add(networkFee))){
            abortController.abort();
            throw new IntermediaryError("Invalid totalFee returned");
        }

        const data: T = new this.swapDataDeserializer(parsedData.data);
        this.swapContract.setUsAsOfferer(data);

        const maxAllowedExpiryDelta: BN = new BN(confirmations+confirmationTarget+this.options.maxExpectedOnchainSendGracePeriodBlocks).mul(new BN(this.options.maxExpectedOnchainSendSafetyFactor)).mul(new BN(this.options.bitcoinBlocktime))
        const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        const maxAllowedExpiryTimestamp: BN = currentTimestamp.add(maxAllowedExpiryDelta);

        if(data.getExpiry().gt(maxAllowedExpiryTimestamp)) {
            console.error("Expiry time returned: "+data.getExpiry()+" maxAllowed: "+maxAllowedExpiryTimestamp);
            abortController.abort();
            throw new IntermediaryError("Expiry time returned too high!");
        }

        if(
            !data.getAmount().eq(total) ||
            data.getHash()!==hash ||
            !data.getEscrowNonce().eq(nonce) ||
            data.getConfirmations()!==confirmations ||
            data.getType()!==ChainSwapType.CHAIN_NONCED
        ) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned");
        }

        if(requiredClaimerKey!=null) {
            if(data.getClaimer()!==requiredClaimerKey) {
                abortController.abort();
                throw new IntermediaryError("Invalid data returned");
            }
        }

        const [pricingInfo, _] = await Promise.all([
            this.verifyReturnedPrice(true, data, amount, parsedData, requiredToken, requiredBaseFee, requiredFeePPM, pricePreFetchPromise, abortController.signal),
            this.verifyReturnedSignature(data, parsedData, feeRatePromise, preFetchSignatureVerificationData, abortController.signal)
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            amount,
            networkFee: parsedData.networkFee,
            swapFee: parsedData.swapFee,
            totalFee: parsedData.totalFee,
            data,
            prefix: parsedData.prefix,
            timeout: parsedData.timeout,
            signature: parsedData.signature,

            expiry: await tryWithRetries(() => preFetchSignatureVerificationData.then(preFetchedData => this.swapContract.getClaimInitAuthorizationExpiry(data, parsedData.timeout, parsedData.prefix, parsedData.signature, preFetchedData))),

            pricingInfo,
            feeRate: feeRatePromise==null ? null : await feeRatePromise
        };
    }

    private async getAndVerifyPrFromLNURL(
        payRequest: LNURLPayParamsWithUrl,
        amount: BN,
        comment?: string
    ): Promise<{
        invoice: string,
        parsedPR: PaymentRequestObject & { tagsObject: TagsObject; },
        successAction: LNURLPaySuccessAction
    }> {
        const params = [
            "amount="+amount.mul(new BN(1000)).toString(10)
        ];
        if(comment!=null) {
            params.push("comment="+encodeURIComponent(comment));
        }

        const queryParams = (payRequest.callback.includes("?") ? "&" : "?")+params.join("&");

        const response: Response = await tryWithRetries(() => fetchWithTimeout(payRequest.callback+queryParams, {
            method: "GET",
            timeout: this.options.getRequestTimeout
        }));

        if(!response.ok) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw new RequestError(resp, response.status);
        }

        let jsonBody: any = await response.json();

        if(jsonBody.status==="ERROR") {
            throw new RequestError("LNURL callback error: "+jsonBody.reason, response.status);
        }

        const invoice = jsonBody.pr;

        const successAction: LNURLPaySuccessAction = jsonBody.successAction;

        if(successAction!=null) {
            switch(successAction.tag) {
                case "message":
                    if(successAction.message==null || successAction.message.length>144) {
                        throw new RequestError("Invalid LNURL success action!", response.status);
                    }
                    break;
                case "url":
                    if(successAction.description==null || successAction.description.length>144 ||
                        successAction.url==null || new URL(successAction.url).hostname!==payRequest.domain) {
                        throw new RequestError("Invalid LNURL success action!", response.status);
                    }
                    break;
                case "aes":
                    if(successAction.description==null || successAction.description.length>144 ||
                        successAction.ciphertext==null || successAction.ciphertext.length>4096 || !BASE64_REGEX.test(successAction.ciphertext) ||
                        successAction.iv==null || successAction.iv.length>24 || !BASE64_REGEX.test(successAction.iv)) {
                        throw new RequestError("Invalid LNURL success action!", response.status);
                    }
                    break;
                default:
                    throw new RequestError("Unsupported LNURL success action!", response.status);
            }
        }

        const parsedPR = bolt11.decode(invoice);

        const descHash = createHash("sha256").update(payRequest.metadata).digest().toString("hex");

        if(parsedPR.tagsObject.purpose_commit_hash!==descHash) {
            throw new RequestError("Invalid invoice received!", response.status);
        }

        const invoiceMSats = new BN(parsedPR.millisatoshis);

        if(!invoiceMSats.eq(amount.mul(new BN(1000)))) {
            throw new RequestError("Invalid lightning invoice received!", response.status);
        }

        return {
            invoice,
            parsedPR,
            successAction
        }
    }

    private async payLightningLNURLExactIn(
        payRequest: LNURLPayParamsWithUrl,
        amount: BN,
        comment: string,
        expirySeconds: number,
        maxFeePromise: Promise<BN>,
        url: string,
        requiredToken?: TokenAddress,
        requiredClaimerKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        preFetchedPrice?: Promise<BN>,
        additionalParams?: Record<string, any>
    ): Promise<{
        confidence: string,
        maxFee: BN,
        swapFee: BN,

        routingFeeSats: BN,

        data: T,

        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,

        invoice: string,
        successAction: LNURLPaySuccessAction,

        expiry: number,

        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {

        const feeRatePromise = this.swapContract.getInitPayInFeeRate==null || requiredClaimerKey==null || requiredToken==null
            ? null
            : tryWithRetries(() => this.swapContract.getInitPayInFeeRate(this.swapContract.getAddress(), requiredClaimerKey, requiredToken, null), null, null);

        const {invoice: dummyInvoice, parsedPR: parsedDummyPR} = await this.getAndVerifyPrFromLNURL(payRequest, new BN(payRequest.minSendable).div(new BN(1000)));

        const expiryTimestamp = new BN(Math.floor(Date.now()/1000)+expirySeconds);

        const maxFee = await maxFeePromise;

        const responseInitial: Response = await tryWithRetries(() => fetchWithTimeout(url+"/payInvoice", {
            method: "POST",
            body: JSON.stringify({
                ...additionalParams,
                pr: dummyInvoice,
                maxFee: maxFee.toString(),
                expiryTimestamp: expiryTimestamp.toString(10),
                token: requiredToken==null ? null : requiredToken.toString(),
                offerer: this.swapContract.getAddress(),
                exactIn: true,
                amount: amount.toString(10)
            }),
            headers: {'Content-Type': 'application/json'},
            timeout: this.options.postRequestTimeout
        }), null, null);

        if(responseInitial.status!==200) {
            let resp: string;
            try {
                resp = await responseInitial.text();
            } catch (e) {
                throw new RequestError(responseInitial.statusText, responseInitial.status);
            }
            throw RequestError.parse(resp, responseInitial.status);
        }

        const jsonBody = await responseInitial.json();

        if(jsonBody.code!==20000) {
            throw RequestError.parse(JSON.stringify(jsonBody), 400);
        }

        if(jsonBody.data.reqId==null) {
            throw new IntermediaryError("Invalid reqId returned");
        }

        if(jsonBody.data.amount==null) {
            throw new IntermediaryError("Invalid amount returned");
        }

        const amountSats = new BN(jsonBody.data.amount);

        if(amountSats.isZero() || amountSats.isNeg()) {
            throw new IntermediaryError("Invalid amount returned (zero or negative)");
        }

        const min = new BN(payRequest.minSendable).div(new BN(1000));
        const max = new BN(payRequest.maxSendable).div(new BN(1000));

        if(amountSats.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amountSats.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        let preFetchSignatureVerificationData: Promise<any>;
        if(jsonBody.signDataPrefetch!=null) {
            if((this.swapContract as any).preFetchForInitSignatureVerification!=null) {
                preFetchSignatureVerificationData = (this.swapContract as any).preFetchForInitSignatureVerification(jsonBody.signDataPrefetch).catch(e => {
                    console.error(e);
                    return null;
                });
            }
        }

        const {invoice, successAction} = await this.getAndVerifyPrFromLNURL(payRequest, amountSats, comment);

        const resp: any = await this.payLightning(
            invoice,
            expirySeconds,
            maxFee,
            url,
            requiredToken,
            requiredClaimerKey,
            requiredBaseFee,
            requiredFeePPM,
            true,
            jsonBody.data.reqId,
            amount,
            expiryTimestamp,
            feeRatePromise,
            preFetchedPrice,
            preFetchSignatureVerificationData,
            additionalParams
        );

        resp.invoice = invoice;
        resp.successAction = successAction;

        return resp;

    }

    async payLightningLNURL(
        lnurl: string | LNURLPayParamsWithUrl,
        amount: BN,
        comment: string,
        expirySeconds: number,
        maxFee: Promise<BN>,
        url: string,
        requiredToken?: TokenAddress,
        requiredClaimerKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        preFetchedPrice?: Promise<BN>,
        exactIn?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<{
        confidence: string,
        maxFee: BN,
        swapFee: BN,

        routingFeeSats: BN,

        data: T,

        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,

        invoice: string,
        successAction: LNURLPaySuccessAction,

        expiry: number,

        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {

        let payRequest: LNURLPayParamsWithUrl;
        if(typeof(lnurl)==="string") {
            let res: any = await this.getLNURL(lnurl);
            if(res==null) {
                throw new UserError("Invalid LNURL");
            }
            if(res.tag!=="payRequest") {
                throw new UserError("Not a lnurl-pay");
            }
            payRequest = res;
        } else {
            payRequest = lnurl;
        }

        if(comment!=null) {
            if(payRequest.commentAllowed==null || comment.length>payRequest.commentAllowed) {
                throw new UserError("Comment not allowed or too long");
            }
        }

        if(exactIn) {
            return await this.payLightningLNURLExactIn(payRequest, amount, comment, expirySeconds, maxFee, url, requiredToken, requiredClaimerKey, requiredBaseFee, requiredFeePPM, preFetchedPrice, additionalParams);
        }

        const min = new BN(payRequest.minSendable).div(new BN(1000));
        const max = new BN(payRequest.maxSendable).div(new BN(1000));

        if(amount.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amount.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        const feeRatePromise = this.swapContract.getInitPayInFeeRate==null || requiredClaimerKey==null || requiredToken==null
            ? null
            : tryWithRetries(() => this.swapContract.getInitPayInFeeRate(this.swapContract.getAddress(), requiredClaimerKey, requiredToken, null), null, null);

        const {invoice, successAction} = await this.getAndVerifyPrFromLNURL(payRequest, amount, comment);

        const resp: any = await this.payLightning(
            invoice,
            expirySeconds,
            await maxFee,
            url,
            requiredToken,
            requiredClaimerKey,
            requiredBaseFee,
            requiredFeePPM,
            false,
            null,
            null,
            null,
            feeRatePromise,
            preFetchedPrice,
            null,
            additionalParams
        );

        resp.invoice = invoice;
        resp.successAction = successAction;

        return resp;
    }

    async payLightning(
        bolt11PayReq: string,
        expirySeconds: number,
        maxFee: BN,
        url: string,
        requiredToken?: TokenAddress,
        requiredClaimerKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        exactIn?: boolean,
        reqId?: string,
        requiredTotal?: BN,
        expiryTimestamp?: BN,
        feeRatePromise?: Promise<any>,
        pricePreFetchPromise?: Promise<BN>,
        preFetchSignatureVerificationData?: Promise<any>,
        additionalParams?: Record<string, any>
    ): Promise<{
        confidence: string,
        maxFee: BN,
        swapFee: BN,

        routingFeeSats: BN,

        data: T,

        prefix: string,
        timeout: string,
        signature: string,

        expiry: number,

        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {
        const parsedPR = bolt11.decode(bolt11PayReq);

        if(parsedPR.satoshis==null) {
            throw new UserError("Must be an invoice with amount");
        }

        const sats: BN = new BN(parsedPR.satoshis);
        if(expiryTimestamp==null) expiryTimestamp = new BN(Math.floor(Date.now()/1000)+expirySeconds);

        const abortController = new AbortController();

        if(pricePreFetchPromise==null) pricePreFetchPromise = this.swapPrice.preFetchPrice==null || requiredToken==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal);
        pricePreFetchPromise = pricePreFetchPromise.catch(e => {
            console.error(e);
            return null;
        });

        const [_, parsedData] = await Promise.all([
            (async () => {
                const payStatus = await tryWithRetries(() => this.swapContract.getPaymentHashStatus(parsedPR.tagsObject.payment_hash), null, null, abortController.signal);

                if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
                    throw new UserError("Invoice already being paid for or paid");
                }
            })(),
            (async () => {
                if(feeRatePromise==null) feeRatePromise = this.swapContract.getInitPayInFeeRate==null || requiredClaimerKey==null || requiredToken==null
                    ? null
                    : tryWithRetries(() => this.swapContract.getInitPayInFeeRate(this.swapContract.getAddress(), requiredClaimerKey, requiredToken, parsedPR.tagsObject.payment_hash), null, null, abortController.signal);

                const {parsedData, preFetchSignatureVerificationData: _preFetchSignatureVerificationData} = await this.postWithRetries(url+(exactIn ? "/payInvoiceExactIn" : "/payInvoice"), {
                    ...additionalParams,
                    reqId,
                    pr: bolt11PayReq,
                    maxFee: maxFee.toString(),
                    expiryTimestamp: expiryTimestamp.toString(10),
                    token: requiredToken==null ? null : requiredToken.toString(),
                    offerer: this.swapContract.getAddress(),
                    amount: null,
                    exactIn: !!exactIn,
                    feeRate: feeRatePromise==null ? null : feeRatePromise.then(val => val==null ? null : val.toString())
                }, {
                    maxFee: FieldTypeEnum.BN,
                    swapFee: FieldTypeEnum.BN,
                    total: FieldTypeEnum.BN,
                    confidence: FieldTypeEnum.Number,
                    address: FieldTypeEnum.String,

                    routingFeeSats: FieldTypeEnum.BN,

                    data: FieldTypeEnum.Any,

                    prefix: FieldTypeEnum.String,
                    timeout: FieldTypeEnum.String,
                    signature: FieldTypeEnum.String
                }, abortController.signal, preFetchSignatureVerificationData==null);

                if(_preFetchSignatureVerificationData!=null) preFetchSignatureVerificationData = _preFetchSignatureVerificationData;

                return parsedData;
            })()
        ]).catch(e => {
            abortController.abort(e);
            throw e;
        });

        const routingFeeSats = parsedData.routingFeeSats;

        if(routingFeeSats.gt(maxFee)) {
            throw new IntermediaryError("Invalid max fee sats returned");
        }

        const maxFeeInToken = parsedData.maxFee;
        const swapFee = parsedData.swapFee;

        const total = parsedData.total;

        const data: T = new this.swapDataDeserializer(parsedData.data);
        this.swapContract.setUsAsOfferer(data);

        console.log("Parsed data: ", data);

        if(requiredTotal!=null) {
            if(!total.eq(requiredTotal)) {
                abortController.abort();
                throw new IntermediaryError("Invalid data returned - total amount");
            }
        }

        if(!data.getAmount().eq(total)) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - amount");
        }

        if(data.getHash()!==parsedPR.tagsObject.payment_hash) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - paymentHash");
        }

        if(!data.getEscrowNonce().eq(new BN(0))) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - nonce");
        }

        if(data.getConfirmations()!==0) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - confirmations");
        }

        if(!data.getExpiry().eq(expiryTimestamp)) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - expiry");
        }

        if(data.getType()!==ChainSwapType.HTLC) {
            abortController.abort();
            throw new IntermediaryError("Invalid data returned - type");
        }

        if(requiredClaimerKey!=null) {
            if(data.getClaimer()!==requiredClaimerKey) {
                abortController.abort();
                throw new IntermediaryError("Invalid data returned");
            }
        }

        const [pricingInfo] = await Promise.all([
            this.verifyReturnedPrice(true, data, sats, {
                networkFee: parsedData.maxFee,
                swapFee: parsedData.swapFee,
                totalFee: parsedData.maxFee.add(parsedData.swapFee)
            }, requiredToken, requiredBaseFee, requiredFeePPM, pricePreFetchPromise, abortController.signal),
            this.verifyReturnedSignature(data, parsedData, feeRatePromise, preFetchSignatureVerificationData, abortController.signal)
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            confidence: parsedData.confidence.toString(),
            maxFee: maxFeeInToken,
            swapFee: swapFee,

            routingFeeSats,

            data,

            prefix: parsedData.prefix,
            timeout: parsedData.timeout,
            signature: parsedData.signature,

            expiry: await tryWithRetries(() => preFetchSignatureVerificationData.then(val => this.swapContract.getClaimInitAuthorizationExpiry(data, parsedData.timeout, parsedData.prefix, parsedData.signature, val))),

            pricingInfo,
            feeRate: feeRatePromise==null ? null : await feeRatePromise
        }
    }

    async getRefundAuthorization(data: T, url: string): Promise<{
        is_paid: boolean,
        txId?: string,
        secret?: string,
        prefix?: string,
        timeout?: string,
        signature?: string
    }> {

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/getRefundAuthorization?paymentHash="+encodeURIComponent(data.getHash())+"&sequence="+encodeURIComponent(data.getSequence().toString(10)), {
            method: "GET",
            timeout: this.options.getRequestTimeout
        }));

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json();

        if(jsonBody.code===20007) {
            //Not found
            return null;
        }

        if(jsonBody.code===20008) {
            //In-flight
            return null;
        }

        if(jsonBody.code===20006) {
            //Already paid
            let txId = null;
            let secret = null;
            if(jsonBody.data!=null) {
                txId = jsonBody.data.txId;
                secret = jsonBody.data.secret;
            }

            if(txId!=null) {
                const btcTx = await tryWithRetries(() => ChainUtils.getTransaction(txId));
                if(btcTx==null) {
                    console.log("BTC tx not found yet!");
                    return null;
                }

                const paymentHashBuffer = Buffer.from(data.getHash(), "hex");

                const foundVout = (btcTx as BitcoinTransaction).vout.find(e =>
                    this.swapContract.getHashForOnchain(Buffer.from(e.scriptpubkey, "hex"), new BN(e.value), data.getEscrowNonce()).equals(paymentHashBuffer));

                if(foundVout==null) {
                    throw new IntermediaryError("Invalid btc txId returned");
                }
            } else if(secret!=null) {

                const secretBuffer = Buffer.from(secret, "hex");
                const hash = createHash("sha256").update(secretBuffer).digest();

                const paymentHashBuffer = Buffer.from(data.getHash(), "hex");

                if(!hash.equals(paymentHashBuffer)) {
                    throw new IntermediaryError("Invalid payment secret returned");
                }
            }

            return {
                is_paid: true,
                txId,
                secret
            };
        }

        if(jsonBody.code===20000) {
            //Success
            const isValidAuthorization = await tryWithRetries(async () => {
                try {
                    await this.swapContract.isValidRefundAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature);
                    return null;
                } catch (e) {
                    if(e instanceof SignatureVerificationError) {
                        return e;
                    }
                    throw e;
                }
            });

            if(isValidAuthorization!=null) throw new IntermediaryError(isValidAuthorization.message);

            return {
                is_paid: false,
                prefix: jsonBody.data.prefix,
                timeout: jsonBody.data.timeout,
                signature: jsonBody.data.signature
            }
        }
    }

    async waitForRefundAuthorization(data: T, url: string, abortSignal?: AbortSignal, intervalSeconds?: number): Promise<{
        is_paid: boolean,
        txId?: string,
        secret?: string,
        prefix?: string,
        timeout?: string,
        signature?: string
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new AbortError();
        }

        while(abortSignal==null || !abortSignal.aborted) {
            const result = await this.getRefundAuthorization(data, url);
            if(result!=null) return result;
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new AbortError();
    }

    async receiveOnchain(
        amountOrTokens: BN,
        url: string,
        requiredToken?: string,
        requiredOffererKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        feeSafetyFactor?: BN,
        blockSafetyFactor?: number,
        exactOut?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<{
        amount: BN,
        address: string,
        swapFee: BN,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        expiry: number,
        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {

        const abortController = new AbortController();

        const sequence: BN = new BN(randomBytes(8));

        //Prefetch price & liquidity
        const liquidityPromise: Promise<BN> = requiredToken==null || requiredOffererKey==null ?
            null :
            tryWithRetries(() => this.swapContract.getIntermediaryBalance(requiredOffererKey, requiredToken), null, null, abortController.signal).catch(e => {
                abortController.abort(e);
                return null;
            });

        const pricePrefetchPromise: Promise<BN> = requiredToken==null || this.swapPrice.preFetchPrice==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal).catch(e => {
            console.error(e);
            return null;
        });

        const dummySwapData = requiredOffererKey==null || requiredToken==null ? null : await this.swapContract.createSwapData(
            ChainSwapType.CHAIN,
            requiredOffererKey,
            this.swapContract.getAddress(),
            requiredToken,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            true,
            null,
            null
        );

        abortController.signal.throwIfAborted();

        const feeRatePromise: Promise<any> = (this.swapContract.getInitFeeRate==null || requiredOffererKey==null || requiredToken==null
            ? Promise.resolve<any>(null)
            : tryWithRetries<any>(() => this.swapContract.getInitFeeRate(requiredOffererKey, this.swapContract.getAddress(), requiredToken), null, null, abortController.signal));

        const initData: Promise<[BN, { blockheight: number, commitHash: string, chainWork: Buffer }, number, BN]> = Promise.all([
            tryWithRetries<BN>(() => this.btcRelay.getFeePerBlock().then(val => val.mul(feeSafetyFactor || new BN(2))), null, null, abortController.signal),

            tryWithRetries<{
                blockheight: number,
                commitHash: string,
                chainWork: Buffer
            }>(() => this.btcRelay.getTipData(), null, null, abortController.signal),

            tryWithRetries<number>(() => this.btcRpc.getTipHeight(), null, null, abortController.signal),

            tryWithRetries<BN>(() => {
                if((this.swapContract as any).getRawClaimFee!=null) {
                    //Workaround for sol
                    return (this.swapContract as any).getRawClaimFee(dummySwapData);
                } else {
                    return this.swapContract.getClaimFee(dummySwapData).then(value => value.mul(feeSafetyFactor || new BN(2)));
                }
            }, null, null, abortController.signal)
        ]);

        blockSafetyFactor = blockSafetyFactor || 2;
        const startTimestamp = new BN(Math.floor(Date.now()/1000));

        const {parsedData, preFetchSignatureVerificationData} = await this.postWithRetries(url+"/getAddress", {
            ...additionalParams,
            address: this.swapContract.getAddress(),
            amount: amountOrTokens.toString(),
            token: requiredToken==null ? null : requiredToken.toString(),

            exactOut,
            sequence: sequence.toString(10),

            claimerBounty: initData.then(([feePerBlock, btcRelayData, currentBtcBlock, addFee]) => {
                const currentBtcRelayBlock = btcRelayData.blockheight;
                const addBlock = Math.max(currentBtcBlock-currentBtcRelayBlock, 0);
                return {
                    feePerBlock: feePerBlock.toString(10),
                    safetyFactor: blockSafetyFactor,
                    startTimestamp: startTimestamp.toString(10),
                    addBlock,
                    addFee: addFee.toString(10)
                };
            }),
            feeRate: feeRatePromise==null ? null : feeRatePromise.then(val => val==null ? null : val.toString())
        }, {
            amount: FieldTypeEnum.BN,
            btcAddress: FieldTypeEnum.String,
            address: FieldTypeEnum.String,
            swapFee: FieldTypeEnum.BN,
            total: FieldTypeEnum.BN,

            data: FieldTypeEnum.Any,

            prefix: FieldTypeEnum.String,
            timeout: FieldTypeEnum.String,
            signature: FieldTypeEnum.String
        }, abortController.signal, true).catch(e => {
            if(!abortController.signal.aborted) abortController.abort(e);
            throw e;
        });

        const [feePerBlock, btcRelayData, currentBtcBlock, addFee] = await initData;
        const currentBtcRelayBlock = btcRelayData.blockheight;
        const addBlock = Math.max(currentBtcBlock-currentBtcRelayBlock, 0);

        const data: T = new this.swapDataDeserializer(parsedData.data);
        this.swapContract.setUsAsClaimer(data);

        console.log("Swap data returned: ", data);

        const tsDelta = data.getExpiry().sub(startTimestamp);
        const blocksDelta = tsDelta.div(new BN(this.options.bitcoinBlocktime)).mul(new BN(blockSafetyFactor));
        const totalBlock = blocksDelta.add(new BN(addBlock));
        const totalClaimerBounty = addFee.add(totalBlock.mul(feePerBlock));

        let amount: BN;
        if(exactOut) {
            if(!data.getAmount().eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid amount returned");
            }
            amount = parsedData.amount;
        } else {
            if(!parsedData.amount.eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid amount returned");
            }
            amount = amountOrTokens;
        }

        if(!data.getClaimerBounty().eq(totalClaimerBounty)) {
            abortController.abort();
            throw new IntermediaryError("Invalid claimer bounty");
        }

        if(data.getConfirmations()>this.options.maxConfirmations) {
            abortController.abort();
            throw new IntermediaryError("Requires too many confirmations");
        }

        if(data.getType()!=ChainSwapType.CHAIN) {
            abortController.abort();
            throw new IntermediaryError("Invalid type of the swap");
        }

        if(!data.getSequence().eq(sequence)) {
            abortController.abort();
            throw new IntermediaryError("Invalid swap sequence");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = this.getOnchainSendTimeout(data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(this.options.minSendWindow))) {
            abortController.abort();
            throw new IntermediaryError("Send window too low");
        }

        const lockingScript = bitcoin.address.toOutputScript(parsedData.btcAddress, this.options.bitcoinNetwork);

        const desiredHash = this.swapContract.getHashForOnchain(lockingScript, amount, new BN(0));

        const suppliedHash = Buffer.from(data.getHash(),"hex");

        if(!desiredHash.equals(suppliedHash)) {
            abortController.abort();
            throw new IntermediaryError("Invalid payment hash returned!");
        }

        if(requiredOffererKey!=null) {
            if(data.getOfferer()!==requiredOffererKey) {
                abortController.abort();
                throw new IntermediaryError("Invalid data returned");
            }
        }

        const swapFee = parsedData.swapFee;

        const [_, pricingInfo] = await Promise.all([
            //Get intermediary's liquidity
            (liquidityPromise || tryWithRetries(() => this.swapContract.getIntermediaryBalance(data.getOfferer(), data.getToken()), null, null, abortController.signal)).then(liquidity => {
                if(liquidity.lt(data.getAmount())) {
                    throw new IntermediaryError("Intermediary doesn't have enough liquidity");
                }
            }),
            this.verifyReturnedPrice(false, data, amount, parsedData, requiredToken, requiredBaseFee, requiredFeePPM, pricePrefetchPromise, abortController.signal),
            this.verifyReturnedSignature(data, parsedData, feeRatePromise, preFetchSignatureVerificationData, abortController.signal)
        ]).catch(e => {
            abortController.abort(e);
            throw e;
        });

        return {
            amount,
            address: parsedData.btcAddress,
            swapFee,
            data,
            prefix: parsedData.prefix,
            timeout: parsedData.timeout,
            signature: parsedData.signature,
            expiry: await tryWithRetries(() => preFetchSignatureVerificationData.then(val => this.swapContract.getInitAuthorizationExpiry(data, parsedData.timeout, parsedData.prefix, parsedData.signature, val))),
            pricingInfo,
            feeRate: feeRatePromise==null ? null : await feeRatePromise
        };

    }

    async postInvoiceToLNURLWithdraw(lnpr: string, k1: string, callbackUrl: string): Promise<void> {
        const params = [
            "pr="+lnpr,
            "k1="+k1
        ];

        const queryParams = (callbackUrl.includes("?") ? "&" : "?")+params.join("&");

        const response: Response = await tryWithRetries(() => fetch(callbackUrl+queryParams, {
            method: "GET"
        }));

        if(!response.ok) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw new RequestError(resp, response.status);
        }

        let jsonBody: any = await response.json();

        if(jsonBody.status==="ERROR") {
            throw new RequestError("LNURL callback error: " + jsonBody.reason, response.status);
        }
    }

    async settleWithLNURLWithdraw(
        lnurl: string | LNURLWithdrawParamsWithUrl,
        pr: string,
        noInstantReceive?: boolean
    ): Promise<{
        withdrawRequest: LNURLWithdrawParamsWithUrl,
        lnurlCallbackResult?: Promise<void>
    }> {
        let withdrawRequest: LNURLWithdrawParamsWithUrl;
        if(typeof(lnurl)==="string") {
            let res: any = await this.getLNURL(lnurl);
            if(res==null) {
                throw new UserError("Invalid LNURL");
            }
            if(res.tag!=="withdrawRequest") {
                throw new UserError("Not a lnurl-pay");
            }
            withdrawRequest = res;
        } else {
            withdrawRequest = lnurl;
        }

        const min = new BN(withdrawRequest.minWithdrawable).div(new BN(1000));
        const max = new BN(withdrawRequest.maxWithdrawable).div(new BN(1000));

        const amount = new BN(bolt11.decode(pr).millisatoshis).div(new BN(1000));

        if(amount.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amount.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        if(noInstantReceive) {
            return {
                withdrawRequest
            };
        }

        return {
            withdrawRequest,
            lnurlCallbackResult: this.postInvoiceToLNURLWithdraw(pr, withdrawRequest.k1, withdrawRequest.callback)
        };
    }

    async receiveLightningLNURL(
        lnurl: string | LNURLWithdrawParamsWithUrl,
        amount: BN,
        url: string,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        noInstantReceive?: boolean,
        additionalParams?: Record<string, any>
    ): Promise<{
        secret: Buffer,
        pr: string,
        swapFee: BN,
        total: BN,
        intermediaryKey: string,
        securityDeposit: BN,
        withdrawRequest: LNURLWithdrawParamsWithUrl,

        lnurlCallbackResult?: Promise<void>,

        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {
        let withdrawRequest: LNURLWithdrawParamsWithUrl;
        if(typeof(lnurl)==="string") {
            let res: any = await this.getLNURL(lnurl);
            if(res==null) {
                throw new UserError("Invalid LNURL");
            }
            if(res.tag!=="withdrawRequest") {
                throw new UserError("Not a lnurl-withdrawal");
            }
            withdrawRequest = res;
        } else {
            withdrawRequest = lnurl;
        }

        const min = new BN(withdrawRequest.minWithdrawable).div(new BN(1000));
        const max = new BN(withdrawRequest.maxWithdrawable).div(new BN(1000));


        if(amount.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amount.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        const resp = await this.receiveLightning(amount, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM, null, null, additionalParams);

        if(noInstantReceive) {
            const anyResp: any = resp;
            anyResp.withdrawRequest = withdrawRequest;
            return anyResp;
        }

        const anyResp: any = resp;
        anyResp.lnurlCallbackResult = this.postInvoiceToLNURLWithdraw(resp.pr, withdrawRequest.k1, withdrawRequest.callback);
        anyResp.withdrawRequest = withdrawRequest;

        return anyResp;
    }

    async receiveLightning(
        amountOrTokens: BN,
        url: string,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        exactOut?: boolean,
        descriptionHash?: Buffer,
        additionalParams?: Record<string, any>
    ): Promise<{
        secret: Buffer,
        pr: string,
        swapFee: BN,
        total: BN,
        intermediaryKey: string,
        securityDeposit: BN,
        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {
        if(descriptionHash!=null) {
            if(descriptionHash.length!==32) {
                throw new UserError("Invalid description hash length");
            }
        }

        const secret = randomBytes(32);

        const paymentHash = createHash("sha256").update(secret).digest();

        const abortController = new AbortController();

        const liquidityPromise: Promise<BN> = requiredToken==null || requiredKey==null ?
            null :
            tryWithRetries(() => this.swapContract.getIntermediaryBalance(requiredKey, requiredToken), null, null, abortController.signal).catch(e => {
                abortController.abort(e);
                return null;
            });
        const pricePrefetchPromise: Promise<BN> = requiredToken==null || this.swapPrice.preFetchPrice==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal).catch(e => {
            console.error(e);
            return null;
        });

        const feeRatePromise: Promise<any> = this.swapContract.getInitFeeRate==null || requiredKey==null || requiredToken==null
            ? null
            : tryWithRetries<any>(() => this.swapContract.getInitFeeRate(requiredKey, this.swapContract.getAddress(), requiredToken));

        const {parsedData} = await this.postWithRetries(url+"/createInvoice", {
            ...additionalParams,
            paymentHash: paymentHash.toString("hex"),
            amount: amountOrTokens.toString(),
            address: this.swapContract.getAddress(),
            token: requiredToken==null ? null : requiredToken.toString(),
            descriptionHash: descriptionHash==null ? null : descriptionHash.toString("hex"),
            exactOut,
            feeRate: feeRatePromise==null ? null : feeRatePromise.then(val => val==null ? null : val.toString())
        }, {
            pr: FieldTypeEnum.String,
            swapFee: FieldTypeEnum.BN,
            total: FieldTypeEnum.BN,
            intermediaryKey: FieldTypeEnum.String,
            securityDeposit: FieldTypeEnum.BN
        }, abortController.signal, false).catch(e => {
            if(!abortController.signal.aborted) abortController.abort(e);
            throw e;
        });

        if(requiredKey!=null && requiredKey!==parsedData.intermediaryKey) {
            abortController.abort();
            throw new IntermediaryError("Invalid intermediary address/pubkey");
        }

        const decodedPR = bolt11.decode(parsedData.pr);

        if(descriptionHash!=null && decodedPR.tagsObject.purpose_commit_hash!==descriptionHash.toString("hex")) {
            abortController.abort();
            throw new IntermediaryError("Invalid pr returned - description hash");
        }

        let amount: BN;
        if(exactOut) {
            if(!parsedData.total.eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid amount returned");
            }
            amount = new BN(decodedPR.millisatoshis).div(new BN(1000));
        } else {
            if(!new BN(decodedPR.millisatoshis).div(new BN(1000)).eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid payment request returned, amount mismatch");
            }
            amount = amountOrTokens;
        }

        const total = parsedData.total;

        if(requiredToken==null) {
            return {
                secret,
                pr: parsedData.pr,
                swapFee: parsedData.swapFee,
                total: parsedData.total,
                intermediaryKey: parsedData.intermediaryKey,
                securityDeposit: parsedData.securityDeposit,
                pricingInfo: null
            };
        }

        const [_, pricingInfo] = await Promise.all([
            (liquidityPromise || tryWithRetries(() => this.swapContract.getIntermediaryBalance(parsedData.intermediaryKey, requiredToken), null, null, abortController.signal)).then(liquidity => {
                if(liquidity.lt(total)) {
                    throw new IntermediaryError("Intermediary doesn't have enough liquidity");
                }
            }),
            this.verifyReturnedPrice(false, {
                isToken: () => true,
                getAmount: () => total,
                getToken: () => requiredToken
            }, amount, parsedData, requiredToken, requiredBaseFee, requiredFeePPM, pricePrefetchPromise, abortController.signal)
        ]).catch(e => {
            abortController.abort(e);
            throw e;
        });

        return {
            secret,
            pr: parsedData.pr,
            swapFee: parsedData.swapFee,
            total: parsedData.total,
            intermediaryKey: parsedData.intermediaryKey,
            securityDeposit: parsedData.securityDeposit,
            pricingInfo,
            feeRate: feeRatePromise==null ? null : await feeRatePromise
        };
    }

    async getPaymentAuthorization(
        bolt11PaymentReq: string,
        url: string,
        requiredToken?: TokenAddress,
        requiredOffererKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        maxSecurityDeposit?: BN,
        minOut?: BN,
        feeRate?: any,
        abortSignal?: AbortSignal
    ): Promise<{
        is_paid: boolean,

        data?: T,
        prefix?: string,
        timeout?: string,
        signature?: string,

        expiry?: number,

        pricingInfo?: PriceInfoType,
        feeRate?: any
    }> {

        const decodedPR = bolt11.decode(bolt11PaymentReq);

        const paymentHash = decodedPR.tagsObject.payment_hash;

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/getInvoicePaymentAuth?paymentHash="+encodeURIComponent(paymentHash), {
            method: "GET",
            signal: abortSignal,
            timeout: this.options.getRequestTimeout
        }), null, null, abortSignal);

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json();

        if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

        if(jsonBody.code===10000) {
            //Authorization returned
            const data: T = new this.swapDataDeserializer(jsonBody.data.data);
            this.swapContract.setUsAsClaimer(data);

            if(requiredOffererKey!=null) {
                if (data.getOfferer()!==requiredOffererKey) {
                    throw new IntermediaryError("Invalid offerer used");
                }
            }

            requiredToken = requiredToken || this.WBTC_ADDRESS;
            if(requiredToken!=null) {
                if (!data.isToken(requiredToken)) {
                    throw new IntermediaryError("Invalid token used");
                }
            }

            if(maxSecurityDeposit!=null && data.getSecurityDeposit().gt(maxSecurityDeposit)) {
                throw new IntermediaryError("Invalid security deposit!");
            }

            const [pricingInfo] = await Promise.all([
                (async () => {
                    if(minOut!=null) {
                        if(data.getAmount().lt(minOut)) throw new IntermediaryError("Invalid amount received");
                    } else {
                        if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                            const isValidAmount = await this.swapPrice.isValidAmountReceive(new BN(decodedPR.satoshis), requiredBaseFee, requiredFeePPM, data.getAmount(), requiredToken);
                            if(!isValidAmount.isValid) {
                                throw new IntermediaryError("Fee too high");
                            }
                            return isValidAmount;
                        }
                    }
                    return null;
                })(),
                tryWithRetries(
                    () => this.swapContract.isValidInitAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, feeRate),
                    null,
                    (e) => e instanceof SignatureVerificationError
                ),
                tryWithRetries<SwapCommitStatus>(
                    () => this.swapContract.getPaymentHashStatus(data.getHash())
                ).then(status => {
                    if(status!==SwapCommitStatus.NOT_COMMITED) throw new Error("Swap already committed on-chain!");
                })
            ]);

            if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

            const paymentHashInTx = data.getHash().toLowerCase();

            console.log("[SmartChain.PaymentRequest] lightning payment hash: ", paymentHashInTx);

            if(paymentHashInTx!==paymentHash.toLowerCase()) {
                throw (new IntermediaryError("Lightning payment request mismatch"));
            }

            const tokenAmount = data.getAmount();

            console.log("[SmartChain.PaymentRequest] Token amount: ", tokenAmount.toString());

            return {
                is_paid: true,
                data,
                prefix: jsonBody.data.prefix,
                timeout: jsonBody.data.timeout,
                signature: jsonBody.data.signature,
                expiry: await tryWithRetries(
                    () => this.swapContract.getInitAuthorizationExpiry(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature),
                    null,
                    null,
                    abortSignal
                ),
                pricingInfo,
                feeRate
            }
        }

        if(jsonBody.code===10003) {
            //Yet unpaid
            return {
                is_paid: false
            };
        }

        throw new PaymentAuthError(jsonBody.msg,  jsonBody.code);
    }

    async waitForIncomingPaymentAuthorization(
        bolt11PaymentReq: string,
        url: string,
        requiredToken?: TokenAddress,
        requiredOffererKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        minSecurityDeposit?: BN,
        minOut?: BN,
        feeRate?: any,
        abortSignal?: AbortSignal,
        intervalSeconds?: number,
    ) : Promise<{
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        expiry: number,
        pricingInfo: PriceInfoType,
        feeRate?: any
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new AbortError();
        }

        while(abortSignal==null || !abortSignal.aborted) {
            const result = await this.getPaymentAuthorization(
                bolt11PaymentReq,
                url,
                requiredToken,
                requiredOffererKey,
                requiredBaseFee,
                requiredFeePPM,
                minSecurityDeposit,
                minOut,
                feeRate,
                abortSignal
            );
            if(result.is_paid) return result as any;
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new AbortError();
    }

}
