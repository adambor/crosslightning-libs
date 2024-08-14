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
import {SwapProgram} from "../programTypes";
import { IntermediaryReputationType } from "crosslightning-base";
import { IdlAccounts } from "@coral-xyz/anchor";

export class SolanaLpVault extends SolanaSwapModule {

    private static readonly CUCosts = {
        WITHDRAW: 50000,
        DEPOSIT: 50000
    };

    /**
     * Action for withdrawing funds from the LP vault
     *
     * @param token
     * @param amount
     * @constructor
     * @private
     */
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

    /**
     * Action for depositing funds to the LP vault
     *
     * @param token
     * @param amount
     * @constructor
     * @private
     */
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

    /**
     * Returns intermediary's reputation & vault balance for a specific token
     *
     * @param address
     * @param token
     */
    public async getIntermediaryData(address: string, token: PublicKey): Promise<{
        balance: BN,
        reputation: IntermediaryReputationType
    }> {
        const data: IdlAccounts<SwapProgram>["userAccount"] = await this.program.account.userAccount.fetchNullable(
            this.root.SwapUserVault(new PublicKey(address), token)
        );

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

    /**
     * Returns intermediary's reputation for a specific token
     *
     * @param address
     * @param token
     */
    public async getIntermediaryReputation(address: string, token: PublicKey): Promise<IntermediaryReputationType> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        return intermediaryData?.reputation;
    }

    /**
     * Returns the balance of the token an intermediary has in his LP vault
     *
     * @param address
     * @param token
     */
    public async getIntermediaryBalance(address: string, token: PublicKey): Promise<BN> {
        const intermediaryData = await this.getIntermediaryData(address, token);
        const balance: BN = intermediaryData?.balance;

        this.logger.debug("getIntermediaryBalance(): token LP balance fetched, token: "+token.toString()+
            " address: "+address+" amount: "+(balance==null ? "null" : balance.toString()));

        return intermediaryData?.balance;
    }

    /**
     * Creates transactions for withdrawing funds from the LP vault, creates ATA if it doesn't exist and unwraps
     *  WSOL to SOL if required
     *
     * @param token
     * @param amount
     * @param feeRate
     */
    public async txsWithdraw(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
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

    /**
     * Creates transaction for depositing funds into the LP vault, wraps SOL to WSOL if required
     *
     * @param token
     * @param amount
     * @param feeRate
     */
    public async txsDeposit(token: PublicKey, amount: BN, feeRate?: string): Promise<SolanaTx[]> {
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