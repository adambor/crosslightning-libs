import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import {TokenAddress} from "crosslightning-base";
import {createHash} from "crypto";
import {SameChainSwapData} from "crosslightning-base/dist/swaps/SameChainSwapData";

export class SolanaSCSwapData extends SameChainSwapData {

    offerer: PublicKey;
    offererToken: PublicKey;
    offererAmount: BN;
    claimer: PublicKey;
    claimerToken: PublicKey;
    claimerAmount: BN;
    expiry: BN;
    payIn: boolean;
    payOut: boolean;

    constructor(
        offerer: PublicKey,
        offererToken: PublicKey,
        offererAmount: BN,
        claimer: PublicKey,
        claimerToken: PublicKey,
        claimerAmount: BN,
        expiry: BN,
        payIn: boolean,
        payOut: boolean,
    );

    constructor(data: any);

    constructor(
        offererOrData: PublicKey | any,
        offererToken?: PublicKey,
        offererAmount?: BN,
        claimer?: PublicKey,
        claimerToken?: PublicKey,
        claimerAmount?: BN,
        expiry?: BN,
        payIn?: boolean,
        payOut?: boolean,
    ) {
        super();
        if(claimer!=null || offererToken!=null || offererAmount!=null || claimerToken!=null || claimerAmount!=null ||
            expiry!=null || payIn!=null || payOut!=null) {

            this.offerer = offererOrData;
            this.offererToken = offererToken;
            this.offererAmount = offererAmount;
            this.claimer = claimer;
            this.claimerToken = claimerToken;
            this.claimerAmount = claimerAmount;
            this.expiry = expiry;
            this.payIn = payIn;
            this.payOut = payOut;
        } else {
            this.offerer = offererOrData.offerer==null ? null : new PublicKey(offererOrData.offerer);
            this.offererToken = offererOrData.offererToken==null ? null : new PublicKey(offererOrData.offererToken);
            this.offererAmount = offererOrData.offererAmount==null ? null : new BN(offererOrData.offererAmount);
            this.claimer = offererOrData.claimer==null ? null : new PublicKey(offererOrData.claimer);
            this.claimerToken = offererOrData.claimerToken==null ? null : new PublicKey(offererOrData.claimerToken);
            this.claimerAmount = offererOrData.claimerAmount==null ? null : new BN(offererOrData.claimerAmount);
            this.expiry = offererOrData.expiry==null ? null : new BN(offererOrData.expiry);
            this.payIn = offererOrData.payIn;
            this.payOut = offererOrData.payOut;
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
            offererToken: this.offererToken==null ? null : this.offererToken.toBase58(),
            offererAmount: this.offererAmount==null ? null : this.offererAmount.toString(10),
            claimer: this.claimer==null ? null : this.claimer.toBase58(),
            claimerToken: this.claimerToken==null ? null : this.claimerToken.toBase58(),
            claimerAmount: this.claimerAmount==null ? null : this.claimerAmount.toString(10),
            expiry: this.expiry==null ? null : this.expiry.toString(10),
            payIn: this.payIn,
            payOut: this.payOut
        }
    }

    getOffererAmount(): BN {
        return this.offererAmount;
    }

    getOffererToken(): TokenAddress {
        return this.offererToken;
    }

    isOffererToken(token: PublicKey): boolean {
        return this.offererToken.equals(token);
    }

    getClaimerAmount(): BN {
        return this.claimerAmount;
    }

    getClaimerToken(): TokenAddress {
        return this.claimerToken;
    }

    isClaimerToken(token: PublicKey): boolean {
        return this.claimerToken.equals(token);
    }

    getExpiry(): BN {
        return this.expiry;
    }

    isPayIn(): boolean {
        return this.payIn;
    }

    isPayOut(): boolean {
        return this.payOut;
    }

    getHash(): string {
        const data = Buffer.concat([
            this.offerer.toBuffer(),
            this.offererToken.toBuffer(),
            this.offererAmount.toBuffer("le", 8),
            this.claimer.toBuffer(),
            this.claimerToken.toBuffer(),
            this.claimerAmount.toBuffer("le", 8),
            this.expiry.toBuffer("le", 8),
            Buffer.from([this.payIn ? 1 : 0, this.payOut ? 1 : 0])
        ]);
        return createHash("sha256").update(data).digest().toString("hex");
    }

    equals(other: SolanaSCSwapData): boolean {
        return other.payIn===this.payIn &&
            other.payOut===this.payOut &&
            other.offerer.equals(this.offerer) &&
            other.offererToken.equals(this.offererToken) &&
            other.offererAmount.eq(this.offererAmount) &&
            other.claimer.equals(this.claimer) &&
            other.claimerToken.equals(this.claimerToken) &&
            other.claimerAmount.eq(this.claimerAmount) &&
            other.expiry.eq(this.expiry)
    }

}

SameChainSwapData.deserializers["sol"] = SolanaSCSwapData;
