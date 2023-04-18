import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import {SwapData, ChainSwapType, TokenAddress} from "crosslightning-base";


export class SolanaSwapData extends SwapData {

    initializer?: PublicKey;
    offerer: PublicKey;
    intermediary: PublicKey;
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
    txoHash: string;

    constructor(
        initializer: PublicKey,
        offerer: PublicKey,
        intermediary: PublicKey,
        token: PublicKey,
        amount: BN,
        paymentHash: string,
        expiry: BN,

        nonce: BN,
        confirmations: number,
        payOut: boolean,
        kind: number,
        payIn: boolean,
        claimerTokenAccount: PublicKey,
        txoHash: string
    );

    constructor(data: any);

    constructor(
        initializerOrData: PublicKey | any,
        offerer?: PublicKey,
        intermediary?: PublicKey,
        token?: PublicKey,
        amount?: BN,
        paymentHash?: string,
        expiry?: BN,
        nonce?: BN,
        confirmations?: number,
        payOut?: boolean,
        kind?: number,
        payIn?: boolean,
        claimerTokenAccount?: PublicKey,
        txoHash?: string,
    ) {
        super();
        if(offerer!=null || intermediary!=null || token!=null || amount!=null || paymentHash!=null || expiry!=null ||
            nonce!=null || confirmations!=null || payOut!=null || kind!=null || payIn!=null || claimerTokenAccount!=null) {

            this.initializer = initializerOrData;
            this.offerer = offerer;
            this.intermediary = intermediary;
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
            this.txoHash = txoHash;
        } else {
            this.initializer = initializerOrData.initializer==null ? null : new PublicKey(initializerOrData.initializer);
            this.offerer = initializerOrData.offerer==null ? null : new PublicKey(initializerOrData.offerer);
            this.intermediary = initializerOrData.intermediary==null ? null : new PublicKey(initializerOrData.intermediary);
            this.token = initializerOrData.token==null ? null : new PublicKey(initializerOrData.token);
            this.amount = initializerOrData.amount==null ? null : new BN(initializerOrData.amount);
            this.paymentHash = initializerOrData.paymentHash;
            this.expiry = initializerOrData.expiry==null ? null : new BN(initializerOrData.expiry);
            this.nonce = initializerOrData.nonce==null ? null : new BN(initializerOrData.nonce);
            this.confirmations = initializerOrData.confirmations;
            this.payOut = initializerOrData.payOut;
            this.kind = initializerOrData.kind;
            this.payIn = initializerOrData.payIn;
            this.claimerTokenAccount = initializerOrData.claimerTokenAccount==null ? null : new PublicKey(initializerOrData.claimerTokenAccount);
            this.txoHash = initializerOrData.txoHash;
        }
    }

    getOfferer(): string {
        return this.offerer.toBase58();
    }

    setOfferer(newOfferer: string) {
        this.offerer = new PublicKey(newOfferer);
    }

    getClaimer(): string {
        return this.intermediary.toBase58();
    }

    setClaimer(newClaimer: string) {
        this.intermediary = new PublicKey(newClaimer);
    }

    serialize(): any {
        return {
            type: "sol",
            initializer: this.initializer==null ? null : this.initializer.toBase58(),
            offerer: this.offerer==null ? null : this.offerer.toBase58(),
            intermediary: this.intermediary==null ? null : this.intermediary.toBase58(),
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

}

SwapData.deserializers["sol"] = SolanaSwapData;
