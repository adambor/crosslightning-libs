import {SolanaSwapModule} from "./SolanaSwapModule";
import {SolanaSwapData} from "../SolanaSwapData";
import {SolanaAction} from "../../base/SolanaAction";
import {TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {ChainSwapType, RelaySynchronizer, SwapDataVerificationError} from "crosslightning-base";
import {PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY} from "@solana/web3.js";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {SolanaBtcStoredHeader} from "../../btcrelay/headers/SolanaBtcStoredHeader";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {getLogger} from "../Utils";
import {SolanaBtcRelay} from "../../btcrelay/SolanaBtcRelay";
import {SolanaSwapProgram} from "../SolanaSwapProgram";
import * as BN from "bn.js";
import {SolanaFees} from "../../base/modules/SolanaFees";

const logger = getLogger("SolanaActionData: ");

export class SolanaActionClaim extends SolanaSwapModule {

    private static readonly CUCosts = {
        CLAIM: 25000,
        CLAIM_PAY_OUT: 50000,
        CLAIM_ONCHAIN: 600000,
        CLAIM_ONCHAIN_PAY_OUT: 600000
    };

    readonly btcRelay: SolanaBtcRelay<any>;

    private Claim(swapData: SolanaSwapData, secret: string): Promise<SolanaAction>;
    private Claim(swapData: SolanaSwapData, dataKey: PublicKey): Promise<SolanaAction>;
    private async Claim(
        swapData: SolanaSwapData,
        secretOrDataKey: string | PublicKey
    ): Promise<SolanaAction> {
        const isDataKey = typeof(secretOrDataKey)!=="string";

        const accounts = {
            signer: this.provider.publicKey,
            initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
            escrowState: this.root.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
            ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            data: isDataKey ? secretOrDataKey : null,
        };
        let secretBuffer = isDataKey ?
            Buffer.alloc(0) :
            Buffer.from(secretOrDataKey, "hex");

        if(swapData.isPayOut()) {
            return new SolanaAction(this.root,
                await this.program.methods
                    .claimerClaimPayOut(secretBuffer)
                    .accounts({
                        ...accounts,
                        claimerAta: swapData.claimerAta,
                        vault: this.root.SwapVault(swapData.token),
                        vaultAuthority: this.root.SwapVaultAuthority,
                        tokenProgram: TOKEN_PROGRAM_ID
                    })
                    .instruction(),
                this.getComputeBudget(swapData)
            );
        } else {
            return new SolanaAction(this.root,
                await this.program.methods
                    .claimerClaim(secretBuffer)
                    .accounts({
                        ...accounts,
                        claimerUserData: this.root.SwapUserVault(swapData.claimer, swapData.token)
                    })
                    .instruction(),
                this.getComputeBudget(swapData)
            );
        }
    }

    private async VerifyAndClaim(
        swapData: SolanaSwapData,
        storeDataKey: PublicKey,
        merkleProof: {reversedTxId: Buffer, pos: number, merkle: Buffer[]},
        commitedHeader: SolanaBtcStoredHeader
    ): Promise<SolanaAction> {
        const action = new SolanaAction(this.root,
            await this.btcRelay.createVerifyIx(
                merkleProof.reversedTxId,
                swapData.confirmations,
                merkleProof.pos,
                merkleProof.merkle,
                commitedHeader
            ),
            0,
            null,
            null,
            true
        );
        action.addAction(await this.Claim(swapData, storeDataKey));
        return action;
    }

    constructor(root: SolanaSwapProgram, btcRelay: SolanaBtcRelay<any>) {
        super(root);
        this.btcRelay = btcRelay;
    }

    private getComputeBudget(swapData: SolanaSwapData) {
        if(swapData.isPayOut()) {
            return SolanaActionClaim.CUCosts[swapData.getType()===ChainSwapType.HTLC ? "CLAIM_PAY_OUT" : "CLAIM_ONCHAIN_PAY_OUT"]
        } else {
            return SolanaActionClaim.CUCosts[swapData.getType()===ChainSwapType.HTLC ? "CLAIM" : "CLAIM_ONCHAIN"];
        }
    }

    /**
     * Gets committed header, identified by blockhash & blockheight, determines required BTC relay blockheight based on
     *  requiredConfirmations
     * If synchronizer is passed & blockhash is not found, it produces transactions to sync up the btc relay to the
     *  current chain tip & adds them to the txs array
     *
     * @param blockheight
     * @param requiredConfirmations
     * @param blockhash
     * @param txs
     * @param synchronizer
     * @private
     */
    private async getCommitedHeaderAndSynchronize(
        blockheight: number,
        requiredConfirmations: number,
        blockhash: string,
        txs: SolanaTx[],
        synchronizer?: RelaySynchronizer<SolanaBtcStoredHeader, SolanaTx, any>,
    ): Promise<SolanaBtcStoredHeader> {
        const requiredBlockheight = blockheight+requiredConfirmations-1;

        const result = await tryWithRetries(
            () => this.btcRelay.retrieveLogAndBlockheight({
                blockhash: blockhash
            }, requiredBlockheight),
            this.retryPolicy
        );

        if(result!=null) return result.header;

        //Need to synchronize
        if(synchronizer==null) return null;

        //TODO: We don't have to synchronize to tip, only to our required blockheight
        const resp = await synchronizer.syncToLatestTxs();
        logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay not synchronized to required blockheight, "+
            "synchronizing ourselves in "+resp.txs.length+" txs");
        logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay computed header map: ",resp.computedHeaderMap);
        resp.txs.forEach(tx => txs.push(tx));

        //Retrieve computed header
        return resp.computedHeaderMap[blockheight];
    }

    private addTxsWriteTransactionData(
        tx: {hex: string, txid: string},
        vout: number,
        feeRate: string,
        txs: SolanaTx[]
    ): Promise<PublicKey> {
        const reversedTxId = Buffer.from(tx.txid, "hex").reverse();
        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            Buffer.from(tx.hex, "hex")
        ]);
        logger.debug("addTxsWriteTransactionData(): writing transaction data: ", writeData.toString("hex"));

        return this.root.DataAccount.addTxsWriteData(reversedTxId, writeData, txs, feeRate);
    }

    /**
     * Checks whether we should unwrap the WSOL to SOL when claiming the swap
     *
     * @param swapData
     * @private
     */
    private shouldUnwrap(swapData: SolanaSwapData): boolean {
        return swapData.isPayOut() &&
            swapData.token.equals(this.root.Tokens.WSOL_ADDRESS) &&
            swapData.claimer.equals(this.provider.publicKey);
    }

    async txsClaimWithSecret(swapData: SolanaSwapData, secret: string, checkExpiry?: boolean, initAta?: boolean, feeRate?: string, skipAtaCheck?: boolean): Promise<SolanaTx[]> {
        //We need to be sure that this transaction confirms in time, otherwise we reveal the secret to the counterparty
        // and won't claim the funds
        if(checkExpiry && this.root.isExpired(swapData)) {
            throw new SwapDataVerificationError("Not enough time to reliably pay the invoice");
        }
        const shouldInitAta = !skipAtaCheck && swapData.isPayOut() && !await this.root.Tokens.ataExists(swapData.claimerAta);
        if(shouldInitAta && !initAta) throw new SwapDataVerificationError("ATA not initialized");

        if(feeRate==null) feeRate = await this.root.getClaimFeeRate(swapData);

        const action = new SolanaAction(this.root);

        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(swapData.offerer, swapData.token, swapData.offererAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address");
            action.add(initAction);
        }
        action.add(await this.Claim(swapData, secret));
        if(this.shouldUnwrap(swapData)) action.add(this.root.Tokens.Unwrap(this.provider.publicKey))

        return [await action.tx(feeRate)];
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
        const shouldInitAta = swapData.isPayOut() && !await this.root.Tokens.ataExists(swapData.claimerAta);
        if(shouldInitAta && !initAta) throw new SwapDataVerificationError("ATA not initialized");

        if(feeRate==null) feeRate = await this.root.getClaimFeeRate(swapData);

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);
        logger.debug("txsClaimWithTxData(): merkle proof computed: ", merkleProof);

        const txs: SolanaTx[] = [];
        if(commitedHeader==null) commitedHeader = await this.getCommitedHeaderAndSynchronize(
            blockheight, swapData.getConfirmations(),
            tx.blockhash, txs, synchronizer
        );

        const storeDataKey = await this.addTxsWriteTransactionData(tx, vout, feeRate, txs);
        if(storageAccHolder!=null) storageAccHolder.storageAcc = storeDataKey;
        logger.debug("txsClaimWithTxData(): tx data written successfully, key: "+storeDataKey.toBase58());

        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(swapData.offerer, swapData.token, swapData.offererAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address");
            await initAction.addToTxs(txs, feeRate);
        }
        const claimAction = await this.VerifyAndClaim(swapData, storeDataKey, merkleProof, commitedHeader);
        await claimAction.addToTxs(txs, feeRate);
        if(this.shouldUnwrap(swapData)) await this.root.Tokens.Unwrap(this.provider.publicKey).addToTxs(txs, feeRate);

        return txs;
    }

    public getClaimFeeRate(swapData: SolanaSwapData): Promise<string> {
        const accounts: PublicKey[] = [this.provider.publicKey];
        if(swapData.payOut) {
            if(swapData.token!=null) accounts.push(this.root.SwapVault(swapData.token));
            if(swapData.payIn) {
                if(swapData.offerer!=null) accounts.push(swapData.offerer);
            } else {
                if(swapData.claimer!=null) accounts.push(swapData.claimer);
            }
            if(swapData.claimerAta!=null && !swapData.claimerAta.equals(PublicKey.default)) accounts.push(swapData.claimerAta);
        } else {
            if(swapData.claimer!=null && swapData.token!=null) accounts.push(this.root.SwapUserVault(swapData.claimer, swapData.token));

            if(swapData.payIn) {
                if(swapData.offerer!=null) accounts.push(swapData.offerer);
            } else {
                if(swapData.claimer!=null) accounts.push(swapData.claimer);
            }
        }

        if(swapData.paymentHash!=null) accounts.push(this.root.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")));

        return this.root.Fees.getFeeRate(accounts);
    }

    public async getClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+5000).add(SolanaFees.getPriorityFee(this.getComputeBudget(swapData), feeRate));
    }

    public async getRawClaimFee(swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(5000);

        feeRate = feeRate || await this.getClaimFeeRate(swapData);

        //Include rent exempt in claim fee, to take into consideration worst case cost when user destroys ATA
        return new BN(this.root.Tokens.SPL_ATA_RENT_EXEMPT+5000).add(SolanaFees.getPriorityFee(this.getComputeBudget(swapData), feeRate));
    }

}