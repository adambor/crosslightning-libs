import {SolanaSwapModule} from "./SolanaSwapModule";
import {SolanaSwapData} from "../SolanaSwapData";
import {createHash} from "crypto";
import {sign} from "tweetnacl";
import {SignatureVerificationError, SwapDataVerificationError} from "crosslightning-base";
import * as BN from "bn.js";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {
    Ed25519Program,
    PublicKey,
    SYSVAR_INSTRUCTIONS_PUBKEY
} from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {SolanaAction} from "../../base/SolanaAction";
import {SolanaFees} from "../../base/modules/SolanaFees";


export class SolanaActionRefund extends SolanaSwapModule {

    private static readonly CUCosts = {
        REFUND: 15000,
        REFUND_PAY_OUT: 50000
    };

    private async Refund(swapData: SolanaSwapData, refundAuthTimeout?: BN): Promise<SolanaAction> {
        const accounts = {
            offerer: swapData.offerer,
            claimer: swapData.claimer,
            escrowState: this.root.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
            claimerUserData: !swapData.payOut ? this.root.SwapUserVault(swapData.claimer, swapData.token) : null,
            ixSysvar: refundAuthTimeout!=null ? SYSVAR_INSTRUCTIONS_PUBKEY : null
        };

        const useTimeout = refundAuthTimeout!=null ? refundAuthTimeout : new BN(0);
        if(swapData.isPayIn()) {
            const ata = getAssociatedTokenAddressSync(swapData.token, swapData.offerer);

            return new SolanaAction(this.root,
                await this.program.methods
                    .offererRefundPayIn(useTimeout)
                    .accounts({
                        ...accounts,
                        offererAta: ata,
                        vault: this.root.SwapVault(swapData.token),
                        vaultAuthority: this.root.SwapVaultAuthority,
                        tokenProgram: TOKEN_PROGRAM_ID
                    })
                    .instruction(),
                SolanaActionRefund.CUCosts.REFUND_PAY_OUT
            );
        } else {
            return new SolanaAction(this.root,
                await this.program.methods
                    .offererRefund(useTimeout)
                    .accounts({
                        ...accounts,
                        offererUserData: this.root.SwapUserVault(swapData.offerer, swapData.token)
                    })
                    .instruction(),
                SolanaActionRefund.CUCosts.REFUND
            );
        }
    }

    private async RefundWithSignature(
        swapData: SolanaSwapData,
        timeout: string,
        prefix: string,
        signature: Buffer
    ): Promise<SolanaAction> {
        const action = new SolanaAction(this.root,
            Ed25519Program.createInstructionWithPublicKey({
                message: this.getRefundMessage(swapData, prefix, timeout),
                publicKey: swapData.claimer.toBuffer(),
                signature: signature
            }),
            0,
            null,
            null,
            true
        );
        action.addAction(await this.Refund(swapData, new BN(timeout)));
        return action;
    }

    /**
     * Gets the message to be signed as a refund authorization
     *
     * @param swapData
     * @param prefix
     * @param timeout
     * @private
     */
    private getRefundMessage(swapData: SolanaSwapData, prefix: string, timeout: string): Buffer {
        const messageBuffers = [
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(prefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[2].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[3].writeBigUInt64LE(BigInt(swapData.sequence.toString(10)));
        messageBuffers[4] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[5].writeBigUInt64LE(BigInt(timeout));

        return createHash("sha256").update(Buffer.concat(messageBuffers)).digest();
    }

    /**
     * Checks whether we should unwrap the WSOL to SOL when refunding the swap
     *
     * @param swapData
     * @private
     */
    private shouldUnwrap(swapData: SolanaSwapData): boolean {
        return swapData.isPayIn() &&
            swapData.token.equals(this.root.Tokens.WSOL_ADDRESS) &&
            swapData.offerer.equals(this.provider.publicKey);
    }

    public signSwapRefund(swapData: SolanaSwapData, authorizationTimeout: number): Promise<{ prefix: string; timeout: string; signature: string }> {
        if(this.provider.signer==null) throw new Error("Unsupported");
        const authPrefix = "refund";
        const authTimeout = Math.floor(Date.now()/1000)+authorizationTimeout;

        const messageBuffer = this.getRefundMessage(swapData, authPrefix, authTimeout.toString(10));
        const signature = sign.detached(messageBuffer, this.provider.signer.secretKey);

        return Promise.resolve({
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    public isSignatureValid(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {
        if(prefix!=="refund") throw new SignatureVerificationError("Invalid prefix");

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(this.root.authGracePeriod));
        if(isExpired) throw new SignatureVerificationError("Authorization expired!");

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = this.getRefundMessage(swapData, prefix, timeout);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, swapData.claimer.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Promise.resolve(messageBuffer);
    }

    public async txsRefund(
        swapData: SolanaSwapData,
        check?: boolean,
        initAta?: boolean,
        feeRate?: string
    ): Promise<SolanaTx[]> {
        if(check && !await tryWithRetries(() => this.root.isRequestRefundable(swapData), this.retryPolicy)) {
            throw new SwapDataVerificationError("Not refundable yet!");
        }
        const shouldInitAta = swapData.isPayIn() && !await this.root.Tokens.ataExists(swapData.offererAta);
        if(shouldInitAta && !initAta) throw new SwapDataVerificationError("ATA not initialized");

        if(feeRate==null) feeRate = await this.root.getRefundFeeRate(swapData)

        const action = new SolanaAction(this.root);
        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(swapData.offerer, swapData.token, swapData.offererAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address")
            action.addAction(initAction);
        }
        action.add(await this.Refund(swapData));
        if(this.shouldUnwrap(swapData)) action.add(this.root.Tokens.Unwrap(this.provider.publicKey));

        return [await action.tx(feeRate)];
    }

    public async txsRefundWithAuthorization(
        swapData: SolanaSwapData,
        timeout: string,
        prefix: string,
        signature: string,
        check?: boolean,
        initAta?: boolean,
        feeRate?: string
    ): Promise<SolanaTx[]> {
        if(check && !await tryWithRetries(() => this.root.isCommited(swapData), this.retryPolicy)) {
            throw new SwapDataVerificationError("Not correctly committed");
        }
        await tryWithRetries(
            () => this.isSignatureValid(swapData, timeout, prefix, signature),
            this.retryPolicy,
            (e) => e instanceof SignatureVerificationError
        );
        const shouldInitAta = swapData.isPayIn() && !await this.root.Tokens.ataExists(swapData.offererAta);
        if(shouldInitAta && !initAta) throw new SwapDataVerificationError("ATA not initialized");

        if(feeRate==null) feeRate = await this.root.getRefundFeeRate(swapData);
        console.log("[SolanaSwapProgram] txsRefundsWithAuthorization: feeRate: ", feeRate);

        const signatureBuffer = Buffer.from(signature, "hex");

        const action = await this.RefundWithSignature(swapData, timeout, prefix, signatureBuffer);
        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(swapData.offerer, swapData.token, swapData.offererAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address");
            action.addAction(initAction, 1); //Need to add it after the Ed25519 verify IX, but before the actual refund IX
        }
        if(this.shouldUnwrap(swapData)) action.add(this.root.Tokens.Unwrap(this.provider.publicKey));

        return [await action.tx(feeRate)];
    }

    public getRefundFeeRate(swapData: SolanaSwapData): Promise<string> {
        const accounts: PublicKey[] = [];
        if(swapData.payIn) {
            if(swapData.token!=null) accounts.push(this.root.SwapVault(swapData.token));
            if(swapData.offerer!=null) accounts.push(swapData.offerer);
            if(swapData.claimer!=null) accounts.push(swapData.claimer);
            if(swapData.offererAta!=null && !swapData.offererAta.equals(PublicKey.default)) accounts.push(swapData.offererAta);
        } else {
            if(swapData.offerer!=null) {
                accounts.push(swapData.offerer);
                if(swapData.token!=null) accounts.push(this.root.SwapUserVault(swapData.offerer, swapData.token));
            }
            if(swapData.claimer!=null) accounts.push(swapData.claimer);
        }

        if(swapData.paymentHash!=null) accounts.push(this.root.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));

        return this.root.Fees.getFeeRate(accounts);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? SolanaActionRefund.CUCosts.REFUND_PAY_OUT : SolanaActionRefund.CUCosts.REFUND;

        return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+10000).add(SolanaFees.getPriorityFee(computeBudget, feeRate));
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    async getRawRefundFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(10000);

        feeRate = feeRate || await this.getRefundFeeRate(swapData);

        const computeBudget = swapData.payIn ? SolanaActionRefund.CUCosts.REFUND_PAY_OUT : SolanaActionRefund.CUCosts.REFUND;

        return new BN(10000).add(SolanaFees.getPriorityFee(computeBudget, feeRate));
    }

}