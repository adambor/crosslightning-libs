import {SolanaSwapModule} from "../SolanaSwapModule";
import {SolanaAction} from "../../base/SolanaAction";
import * as BN from "bn.js";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import {
    Account,
    getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {tryWithRetries} from "../../../utils/Utils";

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
        const shouldUnwrap = token.equals(this.root.Tokens.WSOL_ADDRESS);
        if(shouldUnwrap) action.add(this.root.Tokens.Unwrap(this.provider.publicKey));

        this.logger.debug("txsWithdraw(): withdraw TX created, token: "+token.toString()+
            " amount: "+amount.toString(10)+" unwrapping: "+shouldUnwrap);

        return [await action.tx(feeRate)];
    }

    async txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
        const ata = getAssociatedTokenAddressSync(token, this.provider.publicKey);

        feeRate = feeRate || await this.getFeeRate(token);

        const action = new SolanaAction(this.root);

        let wrapping: boolean = false;
        if(token.equals(this.root.Tokens.WSOL_ADDRESS)) {
            const account = await tryWithRetries<Account>(
                () => this.root.Tokens.getATAOrNull(ata),
                this.retryPolicy
            );
            let balance: BN = account==null ? new BN(0) : new BN(account.amount.toString());
            if(balance.lt(amount)) {
                action.add(this.root.Tokens.Wrap(this.provider.publicKey, amount.sub(balance), account==null));
                wrapping = true;
            }
        }
        action.addAction(await this.Deposit(token, amount));

        this.logger.debug("txsDeposit(): deposit TX created, token: "+token.toString()+
            " amount: "+amount.toString(10)+" wrapping: "+wrapping);

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