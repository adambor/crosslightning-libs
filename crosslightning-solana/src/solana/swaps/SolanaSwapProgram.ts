import {SolanaSwapData} from "./SolanaSwapData";
import {AnchorProvider, DecodeType, IdlAccounts, IdlEvents, IdlTypes, Event, Idl} from "@coral-xyz/anchor";
import * as BN from "bn.js";
import {
    ParsedMessage, PartiallyDecodedInstruction,
    PublicKey, SendOptions,
    Signer,
} from "@solana/web3.js";
import {createHash} from "crypto";
import {SolanaBtcRelay} from "../btcrelay/SolanaBtcRelay";
import * as programIdl from "./programIdl.json";
import {IStorageManager, SwapContract, ChainSwapType, TokenAddress, IntermediaryReputationType,
    SwapCommitStatus} from "crosslightning-base";
import {SolanaBtcStoredHeader} from "../btcrelay/headers/SolanaBtcStoredHeader";
import {RelaySynchronizer} from "crosslightning-base/dist";
import {
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";
import {SwapProgram} from "./programTypes";
import {SolanaRetryPolicy} from "../base/SolanaBase";
import {getLogger} from "./Utils";
import {SolanaProgramBase} from "../program/SolanaProgramBase";
import {SolanaTx} from "../base/modules/SolanaTransactions";
import {SolanaActionInit, SolanaPreFetchData, SolanaPreFetchVerification} from "./modules/SolanaActionInit";
import {SolanaActionData, StoredDataAccount} from "./modules/SolanaActionData";
import {SolanaActionRefund} from "./modules/SolanaActionRefund";
import {SolanaActionClaim} from "./modules/SolanaActionClaim";
import {SolanaLpVault} from "./modules/SolanaLpVault";
import {IdlField} from "@coral-xyz/anchor/dist/cjs/idl";

export type SolanaInitializeEvent = Event<SwapProgram["events"][0], Record<string, any>>;
export type SolanaRefundEvent = Event<SwapProgram["events"][1], Record<string, any>>;
export type SolanaClaimEvent = Event<SwapProgram["events"][2], Record<string, any>>;
export type SolanaSwapEvent = Event<SwapProgram["events"][number], Record<string, any>>;

type DecodedFieldOrNull<D, Defined> = D extends IdlField ? DecodeType<D["type"], Defined> : unknown;
type ArgsTuple<A extends IdlField[], Defined> = {
    [K in A[number]["name"]]: DecodedFieldOrNull<Extract<A[number], { name: K }>, Defined>
};

export type InitializeIxType = {
    name: SwapProgram["instructions"][3]["name"],
    accounts: {
        [key in SwapProgram["instructions"][3]["accounts"][number]["name"]]: PublicKey
    },
    data: ArgsTuple<SwapProgram["instructions"][3]["args"], IdlTypes<SwapProgram>>
};

export type InitializePayInIxType = {
    name: SwapProgram["instructions"][2]["name"],
    accounts: {
        [key in SwapProgram["instructions"][2]["accounts"][number]["name"]]: PublicKey
    },
    data: ArgsTuple<SwapProgram["instructions"][2]["args"], IdlTypes<SwapProgram>>
};

export type IxWithAccounts = InitializeIxType | InitializePayInIxType;

export class SolanaSwapProgram extends SolanaProgramBase<SwapProgram> implements SwapContract<SolanaSwapData, SolanaTx, SolanaPreFetchData, SolanaPreFetchVerification> {

    readonly logger = getLogger("SolanaSwapProgram: ");

    ////////////////////////
    //// Constants
    public readonly ESCROW_STATE_RENT_EXEMPT = 2658720;

    ////////////////////////
    //// PDA accessors
    readonly SwapVaultAuthority = this.pda("authority");
    readonly SwapVault = this.pda("vault", (tokenAddress: PublicKey) => [tokenAddress.toBuffer()]);
    readonly SwapUserVault = this.pda("uservault",
        (publicKey: PublicKey, tokenAddress: PublicKey) => [publicKey.toBuffer(), tokenAddress.toBuffer()]
    );
    readonly SwapEscrowState = this.pda("state", (hash: Buffer) => [hash]);

    ////////////////////////
    //// Timeouts
    readonly claimWithSecretTimeout: number = 45;
    readonly claimWithTxDataTimeout: number = 120;
    readonly refundTimeout: number = 45;
    readonly claimGracePeriod: number = 10*60;
    readonly refundGracePeriod: number = 10*60;
    readonly authGracePeriod: number = 5*60;

    ////////////////////////
    //// Services
    readonly Init: SolanaActionInit;
    readonly Refund: SolanaActionRefund;
    readonly Claim: SolanaActionClaim;
    readonly DataAccount: SolanaActionData;
    readonly LpVault: SolanaLpVault;

    constructor(
        signer: AnchorProvider & {signer?: Signer},
        btcRelay: SolanaBtcRelay<any>,
        storage: IStorageManager<StoredDataAccount>,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFeeEstimator = btcRelay.solanaFeeEstimator || new SolanaFeeEstimator(signer.connection)
    ) {
        super(signer, programIdl, programAddress, retryPolicy, solanaFeeEstimator);

        this.Init = new SolanaActionInit(this);
        this.Refund = new SolanaActionRefund(this);
        this.Claim = new SolanaActionClaim(this, btcRelay);
        this.DataAccount = new SolanaActionData(this, storage);
        this.LpVault = new SolanaLpVault(this);
    }

    async start(): Promise<void> {
        await this.DataAccount.init();
        this.logger.info("start(): sweeping old unused data accounts");
        await this.DataAccount.sweepDataAccounts();
    }

    ////////////////////////////////////////////
    //// Signatures
    preFetchForInitSignatureVerification(data: SolanaPreFetchData): Promise<SolanaPreFetchVerification> {
        return this.Init.preFetchForInitSignatureVerification(data);
    }

    preFetchBlockDataForSignatures(): Promise<SolanaPreFetchData> {
        return this.Init.preFetchBlockDataForSignatures();
    }

    getClaimInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Init.signSwapInitialization(swapData, authorizationTimeout, preFetchedBlockData, feeRate);
    }

    isValidClaimInitAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        return this.Init.isSignatureValid(swapData, timeout, prefix, signature, feeRate, preFetchedData);
    }

    getClaimInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.Init.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isClaimInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.Init.isSignatureExpired(signature, timeout);
    }

    getInitSignature(swapData: SolanaSwapData, authorizationTimeout: number, preFetchedBlockData?: SolanaPreFetchData, feeRate?: string): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Init.signSwapInitialization(swapData, authorizationTimeout, preFetchedBlockData, feeRate);
    }

    isValidInitAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, feeRate?: string, preFetchedData?: SolanaPreFetchVerification): Promise<Buffer> {
        return this.Init.isSignatureValid(swapData, timeout, prefix, signature, feeRate, preFetchedData);
    }

    getInitAuthorizationExpiry(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, preFetchedData?: SolanaPreFetchVerification): Promise<number> {
        return this.Init.getSignatureExpiry(timeout, signature, preFetchedData);
    }

    isInitAuthorizationExpired(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<boolean> {
        return this.Init.isSignatureExpired(signature, timeout);
    }

    getRefundSignature(swapData: SolanaSwapData, authorizationTimeout: number): Promise<{ prefix: string; timeout: string; signature: string }> {
        return this.Refund.signSwapRefund(swapData, authorizationTimeout);
    }

    isValidRefundAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {
        return this.Refund.isSignatureValid(swapData, timeout, prefix, signature);
    }

    getDataSignature(data: Buffer): Promise<string> {
        return this.Signatures.getDataSignature(data);
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        return this.Signatures.isValidDataSignature(data, signature, publicKey);
    }

    ////////////////////////////////////////////
    //// Swap data utils
    isClaimable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeClaimer(data)) return Promise.resolve(false);
        if(this.isExpired(data)) return Promise.resolve(false);
        return this.isCommited(data);
    }

    async isCommited(swapData: SolanaSwapData): Promise<boolean> {
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return false;

        return swapData.correctPDA(account);
    }

    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));
        if(this.areWeOfferer(data)) currentTimestamp = currentTimestamp.sub(new BN(this.refundGracePeriod));
        if(this.areWeClaimer(data)) currentTimestamp = currentTimestamp.add(new BN(this.claimGracePeriod));
        return data.expiry.lt(currentTimestamp);
    }

    isRequestRefundable(data: SolanaSwapData): Promise<boolean> {
        //Swap can only be refunded by the offerer
        if(!this.areWeOfferer(data)) return Promise.resolve(false);

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-this.refundGracePeriod);
        const isExpired = data.expiry.lt(currentTimestamp);
        if(!isExpired) return Promise.resolve(false);

        return this.isCommited(data);
    }

    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            //Also check that swapData's ATA is correct
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.claimer);
            if(!swapData.claimerAta.equals(ourAta)) return false;
        }
        return swapData.claimer.equals(this.provider.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.provider.publicKey);
    }

    setUsAsClaimer(swapData: SolanaSwapData) {
        swapData.claimer = this.provider.publicKey;
        swapData.payIn = false;
        swapData.payOut = true;
        swapData.claimerAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
    }

    setUsAsOfferer(swapData: SolanaSwapData) {
        swapData.offerer = this.provider.publicKey;
        swapData.offererAta = getAssociatedTokenAddressSync(swapData.token, this.provider.publicKey);
        swapData.payIn = true;
    }

    getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer {
        return createHash("sha256").update(Buffer.concat([
            Buffer.from(nonce.toArray("le", 8)),
            Buffer.from(amount.toArray("le", 8)),
            outputScript
        ])).digest();
    }

    ////////////////////////////////////////////
    //// Swap data getters
    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(data.paymentHash, "hex"));
        const escrowState: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        if(escrowState!=null) {
            if(data.correctPDA(escrowState)) {
                if(this.areWeOfferer(data) && this.isExpired(data)) return SwapCommitStatus.REFUNDABLE;
                return SwapCommitStatus.COMMITED;
            }

            if(this.areWeOfferer(data) && this.isExpired(data)) return SwapCommitStatus.EXPIRED;
            return SwapCommitStatus.NOT_COMMITED;
        }

        //Check if paid or what
        const status = await this.Events.findInEvents(escrowStateKey, async (event) => {
            if(event.name==="ClaimEvent") {
                const eventData: IdlEvents<SwapProgram>["ClaimEvent"] = event.data as any;
                if(!eventData.sequence.eq(data.sequence)) return null;
                return SwapCommitStatus.PAID;
            }
            if(event.name==="RefundEvent") {
                const eventData: IdlEvents<SwapProgram>["RefundEvent"] = event.data as any;
                if(!eventData.sequence.eq(data.sequence)) return null;
                if(this.isExpired(data)) return SwapCommitStatus.EXPIRED;
                return SwapCommitStatus.NOT_COMMITED;
            }
        });
        if(status!=null) return status;

        if(this.isExpired(data)) {
            return SwapCommitStatus.EXPIRED;
        }
        return SwapCommitStatus.NOT_COMMITED;
    }

    async getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus> {
        const escrowStateKey = this.SwapEscrowState(Buffer.from(paymentHash, "hex"));
        const abortController = new AbortController();

        //Start fetching events before checking escrow PDA, this call is used when quoting, so saving 100ms here helps a lot!
        const eventsPromise = this.Events.findInEvents(escrowStateKey, async (event) => {
            if(event.name==="ClaimEvent") return SwapCommitStatus.PAID;
            if(event.name==="RefundEvent") return SwapCommitStatus.NOT_COMMITED;
        }, abortController.signal).catch(e => {
            abortController.abort(e)
            return null;
        });

        const escrowState = await this.program.account.escrowState.fetchNullable(escrowStateKey);
        abortController.signal.throwIfAborted();
        if(escrowState!=null) {
            abortController.abort();
            return SwapCommitStatus.COMMITED;
        }

        //Check if paid or what
        const eventsStatus = await eventsPromise;
        abortController.signal.throwIfAborted();
        if(eventsStatus!=null) return eventsStatus;

        return SwapCommitStatus.NOT_COMMITED;
    }

    async getCommitedData(paymentHashHex: string): Promise<SolanaSwapData> {
        const paymentHash = Buffer.from(paymentHashHex, "hex");

        const account: IdlAccounts<SwapProgram>["escrowState"] = await this.program.account.escrowState.fetchNullable(this.SwapEscrowState(paymentHash));
        if(account==null) return null;

        return SolanaSwapData.fromEscrowState(account);
    }

    ////////////////////////////////////////////
    //// Swap data initializer
    createSwapData(
        type: ChainSwapType,
        offerer: string,
        claimer: string,
        token: TokenAddress,
        amount: BN,
        paymentHash: string,
        sequence: BN,
        expiry: BN,
        escrowNonce: BN,
        confirmations: number,
        payIn: boolean,
        payOut: boolean,
        securityDeposit: BN,
        claimerBounty: BN
    ): Promise<SolanaSwapData> {
        const tokenAddr: PublicKey = typeof(token)==="string" ? new PublicKey(token) : token;
        const offererKey = offerer==null ? null : new PublicKey(offerer);
        const claimerKey = claimer==null ? null : new PublicKey(claimer);
        return Promise.resolve(new SolanaSwapData(
            offererKey,
            claimerKey,
            tokenAddr,
            amount,
            paymentHash,
            sequence,
            expiry,
            escrowNonce,
            confirmations,
            payOut,
            type==null ? null : SolanaSwapData.typeToKind(type),
            payIn,
            offererKey==null ? null : payIn ? getAssociatedTokenAddressSync(token, offererKey) : PublicKey.default,
            claimerKey==null ? null : payOut ? getAssociatedTokenAddressSync(token, claimerKey) : PublicKey.default,
            securityDeposit,
            claimerBounty,
            null
        ));
    }

    ////////////////////////////////////////////
    //// Utils
    async getBalance(token: PublicKey, inContract: boolean): Promise<BN> {
        if(inContract) return await this.getIntermediaryBalance(this.provider.publicKey.toString(), token);

        let balance = await this.Tokens.getTokenBalance(token);
        if(token.equals(this.Tokens.WSOL_ADDRESS)) {
            const feeCosts = new BN(5000).add(await this.getCommitFee(null));
            balance = BN.max(balance.sub(feeCosts), new BN(0));
        }
        this.logger.debug("getBalance(): token balance, token: "+token.toBase58()+" balance: "+balance.toString(10));
        return balance;
    }

    async getIntermediaryData(address: string, token: PublicKey): Promise<{
        balance: BN,
        reputation: IntermediaryReputationType
    }> {
        const data: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(this.SwapUserVault(new PublicKey(address), token));

        if(data==null) return null;

        const response: any = [];

        for(let i=0;i<data.successVolume.length;i++) {
            response[i] = {
                successVolume: data.successVolume[i],
                successCount: data.successCount[i],
                failVolume: data.failVolume[i],
                failCount: data.failCount[i],
                coopCloseVolume: data.coopCloseVolume[i],
                coopCloseCount: data.coopCloseCount[i]
            };
        }

        return {
            balance: data.amount,
            reputation: response
        };
    }

    async getIntermediaryReputation(address: string, token: PublicKey): Promise<IntermediaryReputationType> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        return intermediaryData?.reputation;
    }

    async getIntermediaryBalance(address: string, token: PublicKey): Promise<BN> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        return intermediaryData?.balance;
    }

    getAddress(): string {
        return this.Addresses.getAddress();
    }

    isValidAddress(address: string): boolean {
        return this.Addresses.isValidAddress(address);
    }

    getNativeCurrencyAddress(): TokenAddress {
        return this.Tokens.getNativeCurrencyAddress();
    }

    toTokenAddress(address: string): TokenAddress {
        return this.Tokens.toTokenAddress(address);
    }

    ////////////////////////////////////////////
    //// Transaction initializers
    async txsClaimWithSecret(
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        feeRate?: string,
        skipAtaCheck?: boolean
    ): Promise<SolanaTx[]> {
        return this.Claim.txsClaimWithSecret(swapData, secret, checkExpiry, initAta, feeRate, skipAtaCheck)
    }

    async txsClaimWithTxData(
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        storageAccHolder?: {storageAcc: PublicKey},
        feeRate?: string
    ): Promise<SolanaTx[] | null> {
        return this.Claim.txsClaimWithTxData(swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, storageAccHolder, feeRate);
    }

    txsRefund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefund(swapData, check, initAta, feeRate);
    }

    txsRefundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Refund.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);
    }

    txsInitPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInitPayIn(swapData, timeout, prefix, signature, skipChecks, feeRate);
    }

    txsInit(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, skipChecks?: boolean, feeRate?: string): Promise<SolanaTx[]> {
        return this.Init.txsInit(swapData, timeout, prefix, signature, txoHash, skipChecks, feeRate);
    }

    txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsWithdraw(token, amount, feeRate);
    }

    txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        return this.LpVault.txsDeposit(token, amount, feeRate);
    }

    txsTransfer(token: TokenAddress, amount: BN, dstAddress: string): Promise<SolanaTx[]> {
        return this.Tokens.txsTransfer(token, amount, dstAddress);
    }

    ////////////////////////////////////////////
    //// Executors
    async claimWithSecret(
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        waitForConfirmation?: boolean,
        abortSignal?: AbortSignal,
        feeRate?: string
    ): Promise<string> {
        const result = await this.txsClaimWithSecret(swapData, secret, checkExpiry, initAta, feeRate);
        const [signature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);
        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return signature;
    }

    async claimWithTxData(
        swapData: SolanaSwapData,
        blockheight: number,
        tx: { blockhash: string, confirmations: number, txid: string, hex: string },
        vout: number,
        commitedHeader?: SolanaBtcStoredHeader,
        synchronizer?: RelaySynchronizer<any, SolanaTx, any>,
        initAta?: boolean,
        waitForConfirmation?: boolean,
        abortSignal?: AbortSignal,
        feeRate?: string
    ): Promise<string> {
        const data: {storageAcc: PublicKey} = {
            storageAcc: null
        };

        const txs = await this.txsClaimWithTxData(swapData, blockheight, tx, vout, commitedHeader, synchronizer, initAta, data, feeRate);
        if(txs===null) throw new Error("Btc relay not synchronized to required blockheight!");

        //TODO: This doesn't return proper tx signature
        const [signature] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal);
        await this.DataAccount.removeDataAccount(data.storageAcc);

        return signature;
    }

    async refund(swapData: SolanaSwapData, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefund(swapData, check, initAta, feeRate);

        const [signature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signature;
    }

    async refundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, check?: boolean, initAta?: boolean, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsRefundWithAuthorization(swapData,timeout,prefix,signature,check,initAta,feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInitPayIn(swapData,timeout,prefix,signature,skipChecks,feeRate);

        const signatures = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return signatures[signatures.length-1];
    }

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, txoHash?: Buffer, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        let result = await this.txsInit(swapData,timeout,prefix,signature,txoHash,skipChecks,feeRate);

        const [txSignature] = await this.Transactions.sendAndConfirm(result, waitForConfirmation, abortSignal);

        return txSignature;
    }

    async initAndClaimWithSecret(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, secret: string, waitForConfirmation?: boolean, skipChecks?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string[]> {
        const txsCommit = await this.txsInit(swapData, timeout, prefix, signature, null, skipChecks, feeRate);
        const txsClaim = await this.txsClaimWithSecret(swapData, secret, true, false, feeRate, true);

        return await this.Transactions.sendAndConfirm(txsCommit.concat(txsClaim), waitForConfirmation, abortSignal);
    }

    async withdraw(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsWithdraw(token, amount, feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    async deposit(token: PublicKey, amount: BN, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsDeposit(token, amount, feeRate);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    async transfer(token: TokenAddress, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress);
        const [txId] = await this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    ////////////////////////////////////////////
    //// Transactions
    sendAndConfirm(txs: SolanaTx[], waitForConfirmation?: boolean, abortSignal?: AbortSignal, parallel?: boolean, onBeforePublish?: (txId: string, rawTx: string) => Promise<void>): Promise<string[]> {
        return this.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, parallel, onBeforePublish);
    }

    serializeTx(tx: SolanaTx): Promise<string> {
        return this.Transactions.serializeTx(tx);
    }

    deserializeTx(txData: string): Promise<SolanaTx> {
        return this.Transactions.deserializeTx(txData);
    }

    getTxIdStatus(txId: string): Promise<"not_found" | "pending" | "success" | "reverted"> {
        return this.Transactions.getTxIdStatus(txId);
    }

    getTxStatus(tx: string): Promise<"not_found" | "pending" | "success" | "reverted"> {
        return this.Transactions.getTxStatus(tx);
    }

    ////////////////////////////////////////////
    //// Fees
    getInitPayInFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {
        return this.Init.getInitPayInFeeRate(offerer, claimer, token, paymentHash);
    }

    getInitFeeRate(offerer?: string, claimer?: string, token?: PublicKey, paymentHash?: string): Promise<string> {
        return this.Init.getInitFeeRate(offerer, claimer, token, paymentHash);
    }

    getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {
        return this.Refund.getRefundFeeRate(swapData);
    }

    getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {
        return this.Claim.getClaimFeeRate(swapData);
    }

    getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getClaimFee(swapData, feeRate);
    }

    getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Claim.getRawClaimFee(swapData, feeRate);
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Init.getInitFee(swapData, feeRate);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Refund.getRefundFee(swapData, feeRate);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRawRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        return this.Refund.getRawRefundFee(swapData, feeRate);
    }

    ///////////////////////////////////
    //// Callbacks & handlers
    offBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): boolean {
        return true;
    }

    onBeforeTxReplace(callback: (oldTx: string, oldTxId: string, newTx: string, newTxId: string) => Promise<void>): void {}

    onBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): void {
        this.Transactions.onBeforeTxSigned(callback);
    }

    offBeforeTxSigned(callback: (tx: SolanaTx) => Promise<void>): boolean {
        return this.Transactions.offBeforeTxSigned(callback);
    }

    onSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): void {
        this.Transactions.onSendTransaction(callback);
    }

    offSendTransaction(callback: (tx: Buffer, options?: SendOptions) => Promise<string>): boolean {
        return this.Transactions.offSendTransaction(callback);
    }

}
