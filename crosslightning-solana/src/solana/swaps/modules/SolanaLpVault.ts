import {SolanaSwapModule} from "./SolanaSwapModule";
import {SolanaAction} from "../../base/SolanaAction";
import * as BN from "bn.js";
import {PublicKey, SystemProgram, Transaction, TransactionInstruction} from "@solana/web3.js";
import {
    Account,
    createAssociatedTokenAccountInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
    getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {SolanaBase} from "../../base/SolanaBase";


export class SolanaLpVault extends SolanaSwapModule {

    private static readonly CUCosts = {
        WITHDRAW: 50000,
        DEPOSIT: 50000
    };

    private async Withdraw(token: PublicKey, amount: BN): Promise<SolanaAction> {
        const ata = getAssociatedTokenAddressSync(token, this.provider.publicKey);
        return new SolanaAction(this.root,
            await this.program.methods
                .withdraw(new BN(amount))
                .accounts({
                    signer: this.provider.publicKey,
                    signerAta: ata,
                    userData: this.root.SwapUserVault(this.provider.publicKey, token),
                    vault: this.root.SwapVault(token),
                    vaultAuthority: this.root.SwapVaultAuthority,
                    mint: token,
                    tokenProgram: TOKEN_PROGRAM_ID
                })
                .instruction(),
            SolanaLpVault.CUCosts.WITHDRAW
        );
    }

    private async Deposit(token: PublicKey, amount: BN): Promise<SolanaAction> {
        const ata = getAssociatedTokenAddressSync(token, this.provider.publicKey);
        return new SolanaAction(this.root,
            await this.program.methods
                .deposit(new BN(amount))
                .accounts({
                    signer: this.provider.publicKey,
                    signerAta: ata,
                    userData: this.root.SwapUserVault(this.provider.publicKey, token),
                    vault: this.root.SwapVault(token),
                    vaultAuthority: this.root.SwapVaultAuthority,
                    mint: token,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID
                })
                .instruction(),
            SolanaLpVault.CUCosts.DEPOSIT
        );
    }

    async txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);

        feeRate = feeRate || await this.getFeeRate(token);

        const action = new SolanaAction(this.root);
        if(!await this.root.Tokens.ataExists(ata)) {
            action.add(this.root.Tokens.InitAta(this.provider.publicKey, token));
        }
        action.add(await this.Withdraw(token, amount));
        if(token.equals(this.root.Tokens.WSOL_ADDRESS)) action.add(this.root.Tokens.Unwrap(this.provider.publicKey));

        return [await action.tx(feeRate)];
    }

    async txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        const ata = await getAssociatedTokenAddress(token, this.provider.publicKey);

        feeRate = feeRate || await this.getFeeRate(token);

        const action = new SolanaAction(this.root);

        if(token.equals(this.root.Tokens.WSOL_ADDRESS)) {
            const account = await tryWithRetries<Account>(
                () => this.root.Tokens.getATAOrNull(ata),
                this.retryPolicy
            );
            let balance: BN = account==null ? new BN(0) : new BN(account.amount.toString());
            if(balance.lt(amount)) {
                action.add(this.root.Tokens.Wrap(this.provider.publicKey, amount.sub(balance), account==null));
            }
        }
        action.addAction(await this.Deposit(token, amount));

        return [await action.tx(feeRate)];
    }

    public getFeeRate(token: PublicKey) {
        const ata = getAssociatedTokenAddressSync(token, this.provider.publicKey);
        return this.root.Fees.getFeeRate([
            this.provider.publicKey,
            ata,
            this.root.SwapUserVault(this.provider.publicKey, token),
            this.root.SwapVault(token)
        ])
    }

}