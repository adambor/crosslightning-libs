import {SolanaModule} from "../SolanaModule";
import {PublicKey, SystemProgram, Transaction, TransactionInstruction} from "@solana/web3.js";
import {
    Account, createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction, createSyncNativeInstruction, createTransferInstruction,
    getAccount, getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    TokenAccountNotFoundError
} from "@solana/spl-token";
import * as BN from "bn.js";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {SolanaFees} from "./SolanaFees";
import {SolanaTx} from "./SolanaTransactions";
import {SolanaAction} from "../SolanaAction";

export class SolanaTokens extends SolanaModule {

    public static readonly CUCosts = {
        WRAP_SOL: 10000,
        ATA_CLOSE: 10000,
        ATA_INIT: 40000,
        TRANSFER: 50000
    };

    public readonly WSOL_ADDRESS = new PublicKey("So11111111111111111111111111111111111111112");
    public readonly SPL_ATA_RENT_EXEMPT = 2039280;

    ///////////////////
    //// Tokens
    public getATAOrNull(ata: PublicKey): Promise<Account> {
        return getAccount(this.provider.connection, ata).catch(e => {
            if(e instanceof TokenAccountNotFoundError) return null;
            throw e;
        });
    }

    public async ataExists(ata: PublicKey) {
        const account = await tryWithRetries<Account>(
            () => this.getATAOrNull(ata),
            this.retryPolicy
        );
        return account!=null;
    }

    public getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(this.SPL_ATA_RENT_EXEMPT));
    }

    public async getTokenBalance(token: PublicKey) {
        const ata: PublicKey = getAssociatedTokenAddressSync(token, this.provider.publicKey);
        const [ataAccount, balance] = await Promise.all<[Promise<Account>, Promise<number>]>([
            this.getATAOrNull(ata),
            (token!=null && token.equals(this.WSOL_ADDRESS)) ? this.provider.connection.getBalance(this.provider.publicKey) : Promise.resolve(null)
        ]);

        let ataExists: boolean = ataAccount!=null;
        let sum: BN = new BN(0);
        if(ataExists) {
            sum = sum.add(new BN(ataAccount.amount.toString()));
        }

        if(balance!=null) {
            let balanceLamports: BN = new BN(balance);
            if(!ataExists) balanceLamports = balanceLamports.sub(await this.getATARentExemptLamports());
            if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
        }

        return sum;
    }

    public getNativeCurrencyAddress(): PublicKey {
        return this.WSOL_ADDRESS;
    }

    public toTokenAddress(address: string): PublicKey {
        return new PublicKey(address);
    }

    ///////////////////
    //// Transfers
    public async transfer(token: PublicKey, amount: BN, dstAddress: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal, feeRate?: string): Promise<string> {
        const txs = await this.txsTransfer(token, amount, dstAddress, feeRate);
        const [txId] = await this.root.Transactions.sendAndConfirm(txs, waitForConfirmation, abortSignal, false);
        return txId;
    }

    public async txsTransfer(token: PublicKey, amount: BN, dstAddress: string, feeRate?: string): Promise<SolanaTx[]> {
        const recipient = new PublicKey(dstAddress);

        let computeBudget = SolanaTokens.CUCosts.TRANSFER;

        if(this.WSOL_ADDRESS.equals(token)) {
            const wsolAta = getAssociatedTokenAddressSync(token, this.provider.publicKey, false);
            const account = await tryWithRetries<Account>(() => this.getATAOrNull(wsolAta), this.retryPolicy);

            const tx = new Transaction();
            tx.feePayer = this.provider.publicKey;

            if(account!=null) {
                feeRate = feeRate || await this.root.Fees.getFeeRate([this.provider.publicKey, recipient, wsolAta]);
                computeBudget += SolanaTokens.CUCosts.ATA_CLOSE;
                SolanaFees.applyFeeRate(tx, computeBudget, feeRate);
                //Unwrap
                tx.add(
                    createCloseAccountInstruction(wsolAta, this.provider.publicKey, this.provider.publicKey)
                );
            } else {
                feeRate = feeRate || await this.root.Fees.getFeeRate([this.provider.publicKey, recipient]);
                SolanaFees.applyFeeRate(tx, computeBudget, feeRate);
            }

            tx.add(
                SystemProgram.transfer({
                    fromPubkey: this.provider.publicKey,
                    toPubkey: recipient,
                    lamports: BigInt(amount.toString(10))
                })
            );

            SolanaFees.applyFeeRateEnd(tx, computeBudget, feeRate);

            return [{
                tx,
                signers: []
            }];
        }

        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);

        if(!PublicKey.isOnCurve(new PublicKey(dstAddress))) {
            throw new Error("Recipient must be a valid public key");
        }

        const dstAta = getAssociatedTokenAddressSync(token, new PublicKey(dstAddress), false);

        feeRate = feeRate || await this.root.Fees.getFeeRate([this.provider.publicKey, ata, dstAta]);

        const tx = new Transaction();
        tx.feePayer = this.provider.publicKey;

        SolanaFees.applyFeeRate(tx, computeBudget, feeRate);

        const account = await tryWithRetries<Account>(() => this.getATAOrNull(dstAta), this.retryPolicy);
        console.log("Account ATA: ", account);
        if(account==null) {
            tx.add(
                createAssociatedTokenAccountInstruction(this.provider.publicKey, dstAta, new PublicKey(dstAddress), token)
            );
        }

        const ix = createTransferInstruction(ata, dstAta, this.provider.publicKey, BigInt(amount.toString(10)));
        tx.add(ix);

        SolanaFees.applyFeeRateEnd(tx, computeBudget, feeRate);

        return [{
            tx: tx,
            signers: []
        }];
    }

    public InitAta(publicKey: PublicKey, token: PublicKey, requiredAta?: PublicKey): SolanaAction {
        const ata = getAssociatedTokenAddressSync(token, publicKey);
        if(requiredAta!=null && !ata.equals(requiredAta)) return null;
        return new SolanaAction(
            this.root,
            createAssociatedTokenAccountInstruction(
                this.provider.publicKey,
                ata,
                publicKey,
                token
            ),
            SolanaTokens.CUCosts.ATA_INIT
        )
    }

    public Wrap(publicKey: PublicKey, amount: BN, initAta: boolean): SolanaAction {
        const ata = getAssociatedTokenAddressSync(this.WSOL_ADDRESS, publicKey);
        const action = new SolanaAction(this.root);
        if(initAta) action.addIx(
            createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, this.WSOL_ADDRESS),
            SolanaTokens.CUCosts.ATA_INIT
        );
        action.addIx(
            SystemProgram.transfer({
                fromPubkey: publicKey,
                toPubkey: ata,
                lamports: BigInt(amount.toString(10))
            }),
            SolanaTokens.CUCosts.WRAP_SOL
        );
        action.addIx(createSyncNativeInstruction(ata));
        return action;
    }

    public Unwrap(publicKey: PublicKey) {
        const ata = getAssociatedTokenAddressSync(this.WSOL_ADDRESS, publicKey);
        return new SolanaAction(this.root,
            createCloseAccountInstruction(ata, publicKey, publicKey),
            SolanaTokens.CUCosts.ATA_CLOSE
        );
    }

}