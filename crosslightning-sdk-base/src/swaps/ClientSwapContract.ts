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
import {findlnurl, getParams, LNURLPayParams, LNURLPaySuccessAction, LNURLWithdrawParams} from "js-lnurl/lib";
import {RequestError} from "../errors/RequestError";
import {AbortError} from "../errors/AbortError";
import {fetchWithTimeout, tryWithRetries} from "../utils/RetryUtils";
import {PriceInfoType} from "./ISwap";

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

const BITCOIN_BLOCKTIME = 10*60;

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type LNURLPay = {
    type: "pay",
    min: BN,
    max: BN,
    commentMaxLength: number,
    shortDescription: string,
    longDescription?: string,
    icon?: string
}

export type LNURLWithdraw= {
    type: "withdraw",
    min: BN,
    max: BN
}

export const MAIL_REGEX = /(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export class ClientSwapContract<T extends SwapData> {

    readonly btcRpc: BitcoinRpc<any>;
    readonly btcRelay: BtcRelay<any, any, any>;

    readonly swapDataDeserializer: new (data: any) => T;
    readonly swapContract: SwapContract<T, any>;
    readonly WBTC_ADDRESS: TokenAddress;
    readonly swapPrice: ISwapPrice;

    readonly options: ClientSwapContractOptions;

    constructor(
        swapContract: SwapContract<T, any>,
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

    getOnchainSendTimeout(data: SwapData) {
        const tsDelta = (this.options.blocksTillTxConfirms + data.getConfirmations()) * BITCOIN_BLOCKTIME * this.options.safetyFactor;
        return data.getExpiry().sub(new BN(tsDelta));
    }

    init(): Promise<void> {
        return this.swapContract.start();
    }

    private async getLNURL(str: string, shouldRetry?: boolean) : Promise<LNURLPayParams | LNURLWithdrawParams | null> {

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

            if(response.status!==200) {
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
        } else {
            const lnurl = findlnurl(str);
            if(lnurl==null) return null;
            res = await getParams(lnurl);
        }

        return res;
    }

    isLNURL(str: string): boolean {
        return findlnurl(str)!=null || MAIL_REGEX.test(str);
    }

    async getLNURLType(str: string, shouldRetry?: boolean): Promise<LNURLPay | LNURLWithdraw | null> {

        let res: any = await this.getLNURL(str, shouldRetry);

        if(res.tag==="payRequest") {
            const payRequest: LNURLPayParams = res;
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
                icon
            }
        }
        if(res.tag==="withdrawRequest") {
            const payRequest: LNURLWithdrawParams = res;
            return {
                type: "withdraw",
                min: new BN(payRequest.minWithdrawable).div(new BN(1000)),
                max: new BN(payRequest.maxWithdrawable).div(new BN(1000))
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
        exactIn?: boolean
    ): Promise<{
        amount: BN,
        networkFee: BN,
        swapFee: BN,
        totalFee: BN,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        expiry: number,
        pricingInfo: PriceInfoType
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

        const pricePreFetchPromise = this.swapPrice.preFetchPrice==null || requiredToken==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal);

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/payInvoice", {
            method: "POST",
            body: JSON.stringify({
                address,
                amount: amountOrTokens.toString(10),
                confirmationTarget,
                confirmations,
                nonce: nonce.toString(10),
                token: requiredToken==null ? null : requiredToken.toString(),
                offerer: this.swapContract.getAddress(),
                exactIn
            }),
            headers: {'Content-Type': 'application/json'},
            timeout: this.options.postRequestTimeout
        })).catch(e => {
            abortController.abort();
            throw e;
        });

        if(response.status!==200) {
            abortController.abort();
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json().catch(e => {
            abortController.abort();
            throw e;
        });

        const total = new BN(jsonBody.data.total);

        if(exactIn) {
            if(!total.eq(amountOrTokens)) {
                abortController.abort();
                throw new IntermediaryError("Invalid total returned");
            }
            amount = new BN(jsonBody.data.amount);

            hash = this.swapContract.getHashForOnchain(outputScript, amount, nonce).toString("hex");

            console.log("Generated hash: ", hash);

            //This shall never happen with the provided entropy
            // const payStatus = await tryWithRetries(() => this.swapContract.getPaymentHashStatus(hash));
            //
            // if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
            //     throw new UserError("Invoice already being paid for or paid");
            // }
        }

        const swapFee = new BN(jsonBody.data.swapFee);
        const networkFee = new BN(jsonBody.data.networkFee);
        const totalFee = new BN(jsonBody.data.totalFee);

        if(!totalFee.eq(swapFee.add(networkFee))){
            abortController.abort();
            throw new IntermediaryError("Invalid totalFee returned");
        }

        const data: T = new this.swapDataDeserializer(jsonBody.data.data);
        this.swapContract.setUsAsOfferer(data);

        const maxAllowedExpiryDelta = new BN(confirmations+confirmationTarget+this.options.maxExpectedOnchainSendGracePeriodBlocks).mul(new BN(this.options.maxExpectedOnchainSendSafetyFactor)).mul(new BN(this.options.bitcoinBlocktime))
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));
        const maxAllowedExpiryTimestamp = currentTimestamp.add(maxAllowedExpiryDelta);

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
            (async() => {
                if(this.WBTC_ADDRESS!=null) {
                    if(!total.eq(amount.add(totalFee))){
                        throw new IntermediaryError("Invalid total returned");
                    }
                    if(!data.isToken(this.WBTC_ADDRESS)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                } else {
                    if(requiredToken!=null) if(!data.isToken(requiredToken)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                    if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                        const prefetchedPrice = pricePreFetchPromise==null ? null : await pricePreFetchPromise;
                        const isValidSendAmount = await this.swapPrice.isValidAmountSend(amount, requiredBaseFee, requiredFeePPM, total.sub(networkFee), data.getToken(), abortController.signal, prefetchedPrice);
                        if(!isValidSendAmount.isValid) {
                            throw new IntermediaryError("Fee too high");
                        }
                        return isValidSendAmount;
                    }
                }
            })(),
            tryWithRetries(
                () => this.swapContract.isValidClaimInitAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce),
                null,
                e => e instanceof SignatureVerificationError,
                abortController.signal
            )
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            amount,
            networkFee: new BN(jsonBody.data.networkFee),
            swapFee: new BN(jsonBody.data.swapFee),
            totalFee: new BN(jsonBody.data.totalFee),
            data,
            prefix: jsonBody.data.prefix,
            timeout: jsonBody.data.timeout,
            signature: jsonBody.data.signature,
            nonce: jsonBody.data.nonce,

            expiry: await tryWithRetries(() => this.swapContract.getClaimInitAuthorizationExpiry(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce)),

            pricingInfo
        };
    }

    async payLightningLNURL(
        lnurl: string,
        amount: BN,
        comment: string,
        expirySeconds: number,
        maxFee: BN,
        url: string,
        requiredToken?: TokenAddress,
        requiredClaimerKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN
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

        pricingInfo: PriceInfoType
    }> {
        let res: any = await this.getLNURL(lnurl);
        if(res==null) {
            throw new UserError("Invalid LNURL");
        }
        if(res.tag!=="payRequest") {
            throw new UserError("Not a lnurl-pay");
        }

        const payRequest: LNURLPayParams = res;

        const min = new BN(payRequest.minSendable).div(new BN(1000));
        const max = new BN(payRequest.maxSendable).div(new BN(1000));

        if(amount.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amount.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        if(comment!=null) {
            if(payRequest.commentAllowed==null || comment.length>payRequest.commentAllowed) {
                throw new UserError("Comment not allowed or too long");
            }
        }

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

        if(response.status!==200) {
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

        const resp: any = await this.payLightning(
            invoice,
            expirySeconds,
            maxFee,
            url,
            requiredToken,
            requiredClaimerKey,
            requiredBaseFee,
            requiredFeePPM
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
        requiredFeePPM?: BN
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

        expiry: number,

        pricingInfo: PriceInfoType
    }> {
        const parsedPR = bolt11.decode(bolt11PayReq);

        if(parsedPR.satoshis==null) {
            throw new UserError("Must be an invoice with amount");
        }

        const sats: BN = new BN(parsedPR.satoshis);
        const expiryTimestamp = (Math.floor(Date.now()/1000)+expirySeconds).toString();

        const abortController = new AbortController();

        const pricePreFetchPromise = this.swapPrice.preFetchPrice==null || requiredToken==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal);

        const [_, jsonBody] = await Promise.all([
            (async () => {
                const payStatus = await tryWithRetries(() => this.swapContract.getPaymentHashStatus(parsedPR.tagsObject.payment_hash), null, null, abortController.signal);

                if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
                    throw new UserError("Invoice already being paid for or paid");
                }
            })(),
            (async () => {
                const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/payInvoice", {
                    method: "POST",
                    body: JSON.stringify({
                        pr: bolt11PayReq,
                        maxFee: maxFee.toString(),
                        expiryTimestamp,
                        token: requiredToken==null ? null : requiredToken.toString(),
                        offerer: this.swapContract.getAddress()
                    }),
                    headers: {'Content-Type': 'application/json'},
                    signal: abortController.signal,
                    timeout: this.options.postRequestTimeout
                }), null, null, abortController.signal);

                if(response.status!==200) {
                    let resp: string;
                    try {
                        resp = await response.text();
                    } catch (e) {
                        throw new RequestError(response.statusText, response.status);
                    }
                    throw new RequestError(resp, response.status);
                }

                return await response.json();
            })()
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        const routingFeeSats = new BN(jsonBody.data.routingFeeSats);

        if(routingFeeSats.gt(maxFee)) {
            throw new IntermediaryError("Invalid max fee sats returned");
        }

        const maxFeeInToken = new BN(jsonBody.data.maxFee);
        const swapFee = new BN(jsonBody.data.swapFee);
        const totalFee = swapFee.add(maxFeeInToken);

        const total = new BN(jsonBody.data.total);

        const data: T = new this.swapDataDeserializer(jsonBody.data.data);
        this.swapContract.setUsAsOfferer(data);

        console.log("Parsed data: ", data);

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

        if(!data.getExpiry().eq(new BN(expiryTimestamp))) {
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
            (async() => {
                if(this.WBTC_ADDRESS!=null) {
                    if(!total.eq(sats.add(totalFee))){
                        throw new IntermediaryError("Invalid total returned");
                    }
                    if(!data.isToken(this.WBTC_ADDRESS)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                } else {
                    if(requiredToken!=null) if(!data.isToken(requiredToken)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                    if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                        const preFetchedPrice: BN = pricePreFetchPromise==null ? null : await pricePreFetchPromise;
                        const isValidSendAmount = await this.swapPrice.isValidAmountSend(sats, requiredBaseFee.add(routingFeeSats), requiredFeePPM, total, data.getToken(), abortController.signal, preFetchedPrice);
                        if(!isValidSendAmount.isValid) {
                            throw new IntermediaryError("Fee too high");
                        }
                        return isValidSendAmount;
                    }
                }
            })(),
            tryWithRetries(
                () => this.swapContract.isValidClaimInitAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce),
                null,
                e => e instanceof SignatureVerificationError,
                abortController.signal
            )
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            confidence: jsonBody.data.confidence,
            maxFee: maxFeeInToken,
            swapFee: swapFee,

            routingFeeSats,

            data,

            prefix: jsonBody.data.prefix,
            timeout: jsonBody.data.timeout,
            signature: jsonBody.data.signature,
            nonce: jsonBody.data.nonce,

            expiry: await tryWithRetries(() => this.swapContract.getClaimInitAuthorizationExpiry(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce)),

            pricingInfo
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

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/getRefundAuthorization?paymentHash="+encodeURIComponent(data.getHash()), {
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
                const btcTx = await tryWithRetries(() => ChainUtils.getTransaction(txId).catch(e => console.error(e)));
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
        exactOut?: boolean
    ): Promise<{
        amount: BN,
        address: string,
        swapFee: BN,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        expiry: number,
        pricingInfo: PriceInfoType
    }> {

        const abortController = new AbortController();

        //Prefetch price & liquidity
        const liquidityPromise: Promise<BN> = requiredToken==null || requiredOffererKey==null ?
            null :
            tryWithRetries(() => this.swapContract.getIntermediaryBalance(requiredOffererKey, requiredToken), null, null, abortController.signal);
        const pricePrefetchPromise: Promise<BN> = requiredToken==null || this.swapPrice.preFetchPrice==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal);

        const [
            feePerBlock,
            btcRelayData,
            currentBtcBlock,
            addFee
        ] = await Promise.all([
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
                    return (this.swapContract as any).getRawClaimFee();
                } else {
                    return this.swapContract.getClaimFee().then(value => value.mul(feeSafetyFactor || new BN(2)));
                }
            }, null, null, abortController.signal)
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        // const feePerBlock: BN = await tryWithRetries(() => this.btcRelay.getFeePerBlock().then(val => val.mul(feeSafetyFactor || new BN(2))));
        // const btcRelayData = await tryWithRetries(() => this.btcRelay.getTipData());
        // const currentBtcBlock = await tryWithRetries(() => this.btcRpc.getTipHeight());
        // const addFee: BN = await tryWithRetries<BN>(() => {
        //     if((this.swapContract as any).getRawClaimFee!=null) {
        //         //Workaround for sol
        //         return (this.swapContract as any).getRawClaimFee();
        //     } else {
        //         return this.swapContract.getClaimFee().then(value => value.mul(feeSafetyFactor || new BN(2)));
        //     }
        // });

        blockSafetyFactor = blockSafetyFactor || 2;
        const startTimestamp = new BN(Math.floor(Date.now()/1000));
        const currentBtcRelayBlock = btcRelayData.blockheight;
        const addBlock = Math.max(currentBtcBlock-currentBtcRelayBlock, 0);

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/getAddress", {
            method: "POST",
            body: JSON.stringify({
                address: this.swapContract.getAddress(),
                amount: amountOrTokens.toString(),
                token: requiredToken==null ? null : requiredToken.toString(),

                claimerBounty: {
                    feePerBlock: feePerBlock.toString(10),
                    safetyFactor: blockSafetyFactor,
                    startTimestamp: startTimestamp.toString(10),
                    addBlock,
                    addFee: addFee.toString(10)
                },

                exactOut
            }),
            headers: {'Content-Type': 'application/json'},
            timeout: this.options.postRequestTimeout,
            signal: abortController.signal
        }), null, null, abortController.signal).catch(e => {
            abortController.abort();
            throw e;
        });

        if(response.status!==200) {
            abortController.abort();
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json().catch(e => {
            abortController.abort();
            throw e;
        });

        const data: T = new this.swapDataDeserializer(jsonBody.data.data);
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
            amount = new BN(jsonBody.data.amount);
        } else {
            if(!new BN(jsonBody.data.amount).eq(amountOrTokens)) {
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

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = this.getOnchainSendTimeout(data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(this.options.minSendWindow))) {
            abortController.abort();
            throw new IntermediaryError("Send window too low");
        }

        const lockingScript = bitcoin.address.toOutputScript(jsonBody.data.btcAddress, this.options.bitcoinNetwork);

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

        const swapFee = new BN(jsonBody.data.swapFee);

        const [_, pricingInfo] = await Promise.all([
            //Get intermediary's liquidity
            (liquidityPromise || tryWithRetries(() => this.swapContract.getIntermediaryBalance(data.getOfferer(), data.getToken()), null, null, abortController.signal)).then(liquidity => {
                if(liquidity.lt(data.getAmount())) {
                    throw new IntermediaryError("Intermediary doesn't have enough liquidity");
                }
            }),
            //Check swap pricing
            (async() => {
                if(this.WBTC_ADDRESS!=null) {
                    const total = amount.sub(swapFee);
                    if(!data.getAmount().eq(total)) {
                        throw new IntermediaryError("Invalid data returned - amount");
                    }
                    if(!data.isToken(this.WBTC_ADDRESS)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                } else {
                    if(requiredToken!=null) if(!data.isToken(requiredToken)) {
                        throw new IntermediaryError("Invalid data returned - token");
                    }
                    if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                        const prefetchedPrice: BN = pricePrefetchPromise==null ? null : await pricePrefetchPromise;
                        const isValidAmount = await this.swapPrice.isValidAmountReceive(amount, requiredBaseFee, requiredFeePPM, data.getAmount(), data.getToken(), abortController.signal, prefetchedPrice);
                        if(!isValidAmount.isValid) {
                            throw new IntermediaryError("Fee too high");
                        }
                        return isValidAmount;
                    }
                }
            })(),
            //Verify authorization
            tryWithRetries(
                () => this.swapContract.isValidInitAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce),
                null,
                e => e instanceof SignatureVerificationError,
                abortController.signal
            )
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            amount,
            address: jsonBody.data.btcAddress,
            swapFee,
            data,
            prefix: jsonBody.data.prefix,
            timeout: jsonBody.data.timeout,
            signature: jsonBody.data.signature,
            nonce: jsonBody.data.nonce,
            expiry: await tryWithRetries(() => this.swapContract.getInitAuthorizationExpiry(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce)),
            pricingInfo
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

        if(response.status!==200) {
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

    async receiveLightningLNURL(
        lnurl: string,
        amount: BN,
        url: string,
        requiredToken?: TokenAddress,
        requiredKey?: string,
        requiredBaseFee?: BN,
        requiredFeePPM?: BN,
        noInstantReceive?: boolean
    ): Promise<{
        secret: Buffer,
        pr: string,
        swapFee: BN,
        total: BN,
        intermediaryKey: string,
        securityDeposit: BN,
        withdrawRequest: LNURLWithdrawParams,

        lnurlCallbackResult?: Promise<void>,

        pricingInfo: PriceInfoType
    }> {
        let res: any = await this.getLNURL(lnurl);
        if(res==null) {
            throw new UserError("Invalid LNURL");
        }
        if(res.tag!=="withdrawRequest") {
            throw new UserError("Not a lnurl-pay");
        }

        const withdrawRequest: LNURLWithdrawParams = res;

        const min = new BN(withdrawRequest.minWithdrawable).div(new BN(1000));
        const max = new BN(withdrawRequest.maxWithdrawable).div(new BN(1000));


        if(amount.lt(min)) {
            throw new UserError("Amount less than minimum");
        }

        if(amount.gt(max)) {
            throw new UserError("Amount more than maximum");
        }

        const resp = await this.receiveLightning(amount, url, requiredToken, requiredKey, requiredBaseFee, requiredFeePPM);

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
        descriptionHash?: Buffer
    ): Promise<{
        secret: Buffer,
        pr: string,
        swapFee: BN,
        total: BN,
        intermediaryKey: string,
        securityDeposit: BN,
        pricingInfo: PriceInfoType
    }> {
        if(descriptionHash!=null) {
            if(descriptionHash.length!==32) {
                throw new UserError("Invalid description hash length");
            }
        }

        const secret = randomBytes(32);

        const paymentHash = createHash("sha256").update(secret).digest();

        const abortController = new AbortController();

        const liquidityPromise: Promise<BN> = requiredToken==null || requiredKey==null ? null : tryWithRetries(() => this.swapContract.getIntermediaryBalance(requiredKey, requiredToken), null, null, abortController.signal);
        const pricePrefetchPromise: Promise<BN> = requiredToken==null || this.swapPrice.preFetchPrice==null ? null : this.swapPrice.preFetchPrice(requiredToken, abortController.signal);

        const response: Response = await tryWithRetries(() => fetchWithTimeout(url+"/createInvoice", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: paymentHash.toString("hex"),
                amount: amountOrTokens.toString(),
                address: this.swapContract.getAddress(),
                token: requiredToken==null ? null : requiredToken.toString(),
                descriptionHash: descriptionHash==null ? null : descriptionHash.toString("hex"),
                exactOut
            }),
            headers: {'Content-Type': 'application/json'},
            timeout: this.options.postRequestTimeout
        })).catch(e => {
            abortController.abort();
            throw e;
        });

        if(response.status!==200) {
            abortController.abort();
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new RequestError(response.statusText, response.status);
            }
            throw RequestError.parse(resp, response.status);
        }

        let jsonBody: any = await response.json().catch(e => {
            abortController.abort();
            throw e;
        });

        if(requiredKey!=null && requiredKey!==jsonBody.data.intermediaryKey) {
            abortController.abort();
            throw new IntermediaryError("Invalid intermediary address/pubkey");
        }

        const decodedPR = bolt11.decode(jsonBody.data.pr);

        if(descriptionHash!=null && decodedPR.tagsObject.purpose_commit_hash!==descriptionHash.toString("hex")) {
            abortController.abort();
            throw new IntermediaryError("Invalid pr returned - description hash");
        }

        let amount: BN;
        if(exactOut) {
            if(!new BN(jsonBody.data.total).eq(amountOrTokens)) {
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

        const total = new BN(jsonBody.data.total);

        if(requiredToken==null) {
            return {
                secret,
                pr: jsonBody.data.pr,
                swapFee: new BN(jsonBody.data.swapFee),
                total: new BN(jsonBody.data.total),
                intermediaryKey: jsonBody.data.intermediaryKey,
                securityDeposit: new BN(jsonBody.data.securityDeposit),
                pricingInfo: null
            };
        }

        const [_, pricingInfo] = await Promise.all([
            (liquidityPromise || tryWithRetries(() => this.swapContract.getIntermediaryBalance(jsonBody.data.intermediaryKey, requiredToken), null, null, abortController.signal)).then(liquidity => {
                if(liquidity.lt(total)) {
                    throw new IntermediaryError("Intermediary doesn't have enough liquidity");
                }
            }),
            (async() => {
                if(this.WBTC_ADDRESS==null) {
                    if(this.swapPrice!=null && requiredBaseFee!=null && requiredFeePPM!=null) {
                        const prefetchedPrice: BN = pricePrefetchPromise==null ? null : await pricePrefetchPromise;
                        const isValidAmount = await this.swapPrice.isValidAmountReceive(amount, requiredBaseFee, requiredFeePPM, total, requiredToken, abortController.signal, prefetchedPrice);
                        if(!isValidAmount.isValid) {
                            throw new IntermediaryError("Fee too high");
                        }
                        return isValidAmount;
                    }
                }
            })()
        ]).catch(e => {
            abortController.abort();
            throw e;
        });

        return {
            secret,
            pr: jsonBody.data.pr,
            swapFee: new BN(jsonBody.data.swapFee),
            total: new BN(jsonBody.data.total),
            intermediaryKey: jsonBody.data.intermediaryKey,
            securityDeposit: new BN(jsonBody.data.securityDeposit),
            pricingInfo
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
        abortSignal?: AbortSignal
    ): Promise<{
        is_paid: boolean,

        data?: T,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,

        expiry?: number,

        pricingInfo?: PriceInfoType
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

            const [pricingInfo, _] = await Promise.all([
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
                    () => this.swapContract.isValidInitAuthorization(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce),
                    null,
                    (e) => e instanceof SignatureVerificationError
                )
            ]);


            const paymentHashInTx = data.getHash().toLowerCase();

            console.log("[SmartChain.PaymentRequest] lightning payment hash: ", paymentHashInTx);

            if(paymentHashInTx!==paymentHash.toLowerCase()) {
                throw (new IntermediaryError("Lightning payment request mismatch"));
            }

            const tokenAmount = data.getAmount();

            console.log("[SmartChain.PaymentRequest] Token amount: ", tokenAmount.toString());

            if(abortSignal!=null && abortSignal.aborted) throw new AbortError();

            return {
                is_paid: true,
                data,
                prefix: jsonBody.data.prefix,
                timeout: jsonBody.data.timeout,
                signature: jsonBody.data.signature,
                nonce: jsonBody.data.nonce,
                expiry: await tryWithRetries(
                    () => this.swapContract.getInitAuthorizationExpiry(data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce),
                    null,
                    null,
                    abortSignal
                ),
                pricingInfo
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
        abortSignal?: AbortSignal,
        intervalSeconds?: number,
    ) : Promise<{
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        expiry: number,
        pricingInfo: PriceInfoType
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
                abortSignal
            );
            if(result.is_paid) return result as any;
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new AbortError();
    }

}
