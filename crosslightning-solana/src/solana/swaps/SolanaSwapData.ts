import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import {SwapData, ChainSwapType, TokenAddress} from "crosslightning-base";

const EXPIRY_BLOCKHEIGHT_THRESHOLD = new BN("1000000000");

export class SolanaSwapData extends SwapData {

    offerer: PublicKey;
    claimer: PublicKey;
    token: PublicKey;
    amount: BN;
    paymentHash: string;
    expiry: BN;
    nonce: BN;
    confirmations: number;
    payOut: boolean;
    kind: number;
    payIn: boolean;
    claimerTokenAccount?: PublicKey;
    initializerTokenAccount?: PublicKey;

    securityDeposit: BN;
    claimerBounty: BN;

    txoHash: string;

    constructor(
        offerer: PublicKey,
        claimer: PublicKey,
        token: PublicKey,
        amount: BN,
        paymentHash: string,
        expiry: BN,

        nonce: BN,
        confirmations: number,
        payOut: boolean,
        kind: number,
        payIn: boolean,
        initializerTokenAccount: PublicKey,
        claimerTokenAccount: PublicKey,

        securityDeposit: BN,
        claimerBounty: BN,

        txoHash: string
    );

    constructor(data: any);

    constructor(
        offererOrData: PublicKey | any,
        claimer?: PublicKey,
        token?: PublicKey,
        amount?: BN,
        paymentHash?: string,
        expiry?: BN,
        nonce?: BN,
        confirmations?: number,
        payOut?: boolean,
        kind?: number,
        payIn?: boolean,
        initializerTokenAccount?: PublicKey,
        claimerTokenAccount?: PublicKey,
        securityDeposit?: BN,
        claimerBounty?: BN,
        txoHash?: string,
    ) {
        super();
        if(claimer!=null || token!=null || amount!=null || paymentHash!=null || expiry!=null ||
            nonce!=null || confirmations!=null || payOut!=null || kind!=null || payIn!=null || claimerTokenAccount!=null) {

            this.offerer = offererOrData;
            this.claimer = claimer;
            this.token = token;
            this.amount = amount;
            this.paymentHash = paymentHash;
            this.expiry = expiry;
            this.nonce = nonce;
            this.confirmations = confirmations;
            this.payOut = payOut;
            this.kind = kind;
            this.payIn = payIn;
            this.claimerTokenAccount = claimerTokenAccount;
            this.initializerTokenAccount = initializerTokenAccount;
            this.securityDeposit = securityDeposit;
            this.claimerBounty = claimerBounty;
            this.txoHash = txoHash;
        } else {
            this.offerer = offererOrData.offerer==null ? null : new PublicKey(offererOrData.offerer);
            this.claimer = offererOrData.claimer==null ? null : new PublicKey(offererOrData.claimer);
            this.token = offererOrData.token==null ? null : new PublicKey(offererOrData.token);
            this.amount = offererOrData.amount==null ? null : new BN(offererOrData.amount);
            this.paymentHash = offererOrData.paymentHash;
            this.expiry = offererOrData.expiry==null ? null : new BN(offererOrData.expiry);
            this.nonce = offererOrData.nonce==null ? null : new BN(offererOrData.nonce);
            this.confirmations = offererOrData.confirmations;
            this.payOut = offererOrData.payOut;
            this.kind = offererOrData.kind;
            this.payIn = offererOrData.payIn;
            this.claimerTokenAccount = offererOrData.claimerTokenAccount==null ? null : new PublicKey(offererOrData.claimerTokenAccount);
            this.initializerTokenAccount = offererOrData.initializerTokenAccount==null ? null : new PublicKey(offererOrData.initializerTokenAccount);
            this.securityDeposit = offererOrData.securityDeposit==null ? null : new BN(offererOrData.securityDeposit);
            this.claimerBounty = offererOrData.claimerBounty==null ? null : new BN(offererOrData.claimerBounty);
            this.txoHash = offererOrData.txoHash;
        }
    }

    getOfferer(): string {
        return this.offerer.toBase58();
    }

    setOfferer(newOfferer: string) {
        this.offerer = new PublicKey(newOfferer);
    }

    getClaimer(): string {
        return this.claimer.toBase58();
    }

    setClaimer(newClaimer: string) {
        this.claimer = new PublicKey(newClaimer);
    }

    serialize(): any {
        return {
            type: "sol",
            offerer: this.offerer==null ? null : this.offerer.toBase58(),
            claimer: this.claimer==null ? null : this.claimer.toBase58(),
            token: this.token==null ? null : this.token.toBase58(),
            amount: this.amount==null ? null : this.amount.toString(10),
            paymentHash: this.paymentHash,
            expiry: this.expiry==null ? null : this.expiry.toString(10),
            nonce: this.nonce==null ? null : this.nonce.toString(10),
            confirmations: this.confirmations,
            payOut: this.payOut,
            kind: this.kind,
            payIn: this.payIn,
            claimerTokenAccount: this.claimerTokenAccount==null ? null : this.claimerTokenAccount.toBase58(),
            securityDeposit: this.securityDeposit==null ? null : this.securityDeposit.toString(10),
            claimerBounty: this.claimerBounty==null ? null : this.claimerBounty.toString(10),
            txoHash: this.txoHash
        }
    }

    getAmount(): BN {
        return this.amount;
    }

    getToken(): TokenAddress {
        return this.token;
    }

    isToken(token: PublicKey): boolean {
        return this.token.equals(token);
    }

    getType(): ChainSwapType {
        switch(this.kind) {
            case 0:
                return ChainSwapType.HTLC;
            case 1:
                return ChainSwapType.CHAIN;
            case 2:
                return ChainSwapType.CHAIN_NONCED;
        }
        return null;
    }

    getExpiry(): BN {
        if(this.expiry.lt(EXPIRY_BLOCKHEIGHT_THRESHOLD)) return null;
        return this.expiry;
    }

    getConfirmations(): number {
        return this.confirmations;
    }

    getEscrowNonce(): BN {
        return this.nonce;
    }

    isPayIn(): boolean {
        return this.payIn;
    }

    isPayOut(): boolean {
        return this.payOut;
    }

    getHash(): string {
        return this.paymentHash;
    }

    getTxoHash(): string {
        return this.txoHash;
    }

    setTxoHash(txoHash: string): void {
        this.txoHash = txoHash;
    }

    getSecurityDeposit() {
        return this.securityDeposit;
    }

    getClaimerBounty() {
        return this.claimerBounty;
    }

    getTotalDeposit() {
        return this.claimerBounty.lt(this.securityDeposit) ? this.securityDeposit : this.claimerBounty;
    }

    correctPDA(account: any): boolean {
        return account.kind===this.kind &&
            account.confirmations===this.confirmations &&
            this.nonce.eq(account.nonce) &&
            Buffer.from(account.hash).toString("hex")===this.paymentHash &&
            account.payIn===this.payIn &&
            account.payOut===this.payOut &&
            account.offerer.equals(this.offerer) &&
            account.claimer.equals(this.claimer) &&
            new BN(account.expiry.toString(10)).eq(this.expiry) &&
            new BN(account.initializerAmount.toString(10)).eq(this.amount) &&
            new BN(account.securityDeposit.toString(10)).eq(this.securityDeposit) &&
            new BN(account.claimerBounty.toString(10)).eq(this.claimerBounty) &&
            account.mint.equals(this.token) &&
            (this.claimerTokenAccount==null || account.claimerTokenAccount.equals(this.claimerTokenAccount)) &&
            (this.initializerTokenAccount==null || account.initializerDepositTokenAccount.equals(this.initializerTokenAccount));
    }

    equals(other: SolanaSwapData): boolean {
        if(this.claimerTokenAccount==null && other.claimerTokenAccount!=null) return false;
        if(this.claimerTokenAccount!=null && other.claimerTokenAccount==null) return false;
        if(this.claimerTokenAccount!=null && other.claimerTokenAccount!=null) {
            if(!this.claimerTokenAccount.equals(other.claimerTokenAccount)) return false;
        }

        if(this.initializerTokenAccount==null && other.initializerTokenAccount!=null) return false;
        if(this.initializerTokenAccount!=null && other.initializerTokenAccount==null) return false;
        if(this.initializerTokenAccount!=null && other.initializerTokenAccount!=null) {
            if(!this.initializerTokenAccount.equals(other.initializerTokenAccount)) return false;
        }

        return other.kind===this.kind &&
            other.confirmations===this.confirmations &&
            this.nonce.eq(other.nonce) &&
            other.paymentHash===this.paymentHash &&
            other.payIn===this.payIn &&
            other.payOut===this.payOut &&
            other.offerer.equals(this.offerer) &&
            other.claimer.equals(this.claimer) &&
            other.expiry.eq(this.expiry) &&
            other.amount.eq(this.amount) &&
            other.securityDeposit.eq(this.securityDeposit) &&
            other.claimerBounty.eq(this.claimerBounty) &&
            other.token.equals(this.token)
    }

}

SwapData.deserializers["sol"] = SolanaSwapData;
