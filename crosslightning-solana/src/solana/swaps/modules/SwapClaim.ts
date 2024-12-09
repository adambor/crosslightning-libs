import {SolanaSwapModule} from "../SolanaSwapModule";
import {SolanaSwapData} from "../SolanaSwapData";
import {SolanaAction} from "../../base/SolanaAction";
import {TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {ChainSwapType, RelaySynchronizer, SwapDataVerificationError} from "crosslightning-base";
import {PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY} from "@solana/web3.js";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {SolanaBtcStoredHeader} from "../../btcrelay/headers/SolanaBtcStoredHeader";
import {tryWithRetries} from "../../../utils/Utils";
import {SolanaBtcRelay} from "../../btcrelay/SolanaBtcRelay";
import {SolanaSwapProgram} from "../SolanaSwapProgram";
import * as BN from "bn.js";
import {SolanaSigner} from "../../wallet/SolanaSigner";

export class SwapClaim extends SolanaSwapModule {

    private static readonly CUCosts = {
        CLAIM: 25000,
        CLAIM_PAY_OUT: 50000,
        CLAIM_ONCHAIN: 600000,
        CLAIM_ONCHAIN_PAY_OUT: 600000
    };

    readonly btcRelay: SolanaBtcRelay<any>;

    /**
     * Claim action which uses the provided hex encoded secret for claiming the swap
     *
     * @param signer
     * @param swapData
     * @param secret
     * @constructor
     * @private
     */
    private Claim(signer: PublicKey, swapData: SolanaSwapData, secret: string): Promise<SolanaAction>;
    /**
     * Claim action which uses data in the provided data ccount with dataKey to claim the swap
     *
     * @param signer
     * @param swapData
     * @param dataKey
     * @constructor
     * @private
     */
    private Claim(signer: PublicKey, swapData: SolanaSwapData, dataKey: PublicKey): Promise<SolanaAction>;
    private async Claim(
        signer: PublicKey,
        swapData: SolanaSwapData,
        secretOrDataKey: string | PublicKey
    ): Promise<SolanaAction> {
        const isDataKey = typeof(secretOrDataKey)!=="string";

        const accounts = {
            signer,
            initializer: swapData.isPayIn() ? swapData.offerer : swapData.claimer,
            escrowState: this.root.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
            ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            data: isDataKey ? secretOrDataKey : null,
        };
        let secretBuffer = isDataKey ?
            Buffer.alloc(0) :
            Buffer.from(secretOrDataKey, "hex");

        if(swapData.isPayOut()) {
            return new SolanaAction(signer, this.root,
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
            return new SolanaAction(signer, this.root,
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

    /**
     * Verify and claim action required for BTC on-chain swaps verified through btc relay, adds the btc relay verify
     *  instruction to the 0th index in the transaction, also intentionally sets compute budget to null such that no
     *  compute budget instruction is added, since that takes up too much space and txs are limited to 1232 bytes
     *
     * @param signer
     * @param swapData
     * @param storeDataKey
     * @param merkleProof
     * @param commitedHeader
     * @constructor
     * @private
     */
    private async VerifyAndClaim(
        signer: PublicKey,
        swapData: SolanaSwapData,
        storeDataKey: PublicKey,
        merkleProof: {reversedTxId: Buffer, pos: number, merkle: Buffer[]},
        commitedHeader: SolanaBtcStoredHeader
    ): Promise<SolanaAction> {
        const action = await this.btcRelay.Verify(
            signer,
            merkleProof.reversedTxId,
            swapData.confirmations,
            merkleProof.pos,
            merkleProof.merkle,
            commitedHeader
        );
        action.addAction(await this.Claim(signer, swapData, storeDataKey));
        action.computeBudget = null;
        return action;
    }

    constructor(root: SolanaSwapProgram, btcRelay: SolanaBtcRelay<any>) {
        super(root);
        this.btcRelay = btcRelay;
    }

    /**
     * Gets the compute budget required for claiming the swap
     *
     * @param swapData
     * @private
     */
    private getComputeBudget(swapData: SolanaSwapData) {
        if(swapData.isPayOut()) {
            return SwapClaim.CUCosts[swapData.getType()===ChainSwapType.HTLC ? "CLAIM_PAY_OUT" : "CLAIM_ONCHAIN_PAY_OUT"]
        } else {
            return SwapClaim.CUCosts[swapData.getType()===ChainSwapType.HTLC ? "CLAIM" : "CLAIM_ONCHAIN"];
        }
    }

    /**
     * Gets committed header, identified by blockhash & blockheight, determines required BTC relay blockheight based on
     *  requiredConfirmations
     * If synchronizer is passed & blockhash is not found, it produces transactions to sync up the btc relay to the
     *  current chain tip & adds them to the txs array
     *
     * @param signer
     * @param txBlockheight transaction blockheight
     * @param requiredConfirmations required confirmation for the swap to be claimable with that TX
     * @param blockhash blockhash of the block which includes the transaction
     * @param txs solana transaction array, in case we need to synchronize the btc relay ourselves the synchronization
     *  txns are added here
     * @param synchronizer optional synchronizer to use to synchronize the btc relay in case it is not yet synchronized
     *  to the required blockheight
     * @private
     */
    private async getCommitedHeaderAndSynchronize(
        signer: PublicKey,
        txBlockheight: number,
        requiredConfirmations: number,
        blockhash: string,
        txs: SolanaTx[],
        synchronizer?: RelaySynchronizer<SolanaBtcStoredHeader, SolanaTx, any>,
    ): Promise<SolanaBtcStoredHeader> {
        const requiredBlockheight = txBlockheight+requiredConfirmations-1;

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
        const resp = await synchronizer.syncToLatestTxs(signer.toString());
        this.logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay not synchronized to required blockheight, "+
            "synchronizing ourselves in "+resp.txs.length+" txs");
        this.logger.debug("getCommitedHeaderAndSynchronize(): BTC Relay computed header map: ",resp.computedHeaderMap);
        resp.txs.forEach(tx => txs.push(tx));

        //Retrieve computed header
        return resp.computedHeaderMap[txBlockheight];
    }

    /**
     * Adds the transactions required for initialization and writing of transaction data to the data account
     *
     * @param signer
     * @param tx transaction to be written
     * @param vout vout of the transaction to use to satisfy swap conditions
     * @param feeRate fee rate for the transactions
     * @param txs solana transaction array, init & write transactions are added here
     * @private
     * @returns {Promise<PublicKey>} publicKey/address of the data account
     */
    private addTxsWriteTransactionData(
        signer: PublicKey | SolanaSigner,
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
        this.logger.debug("addTxsWriteTransactionData(): writing transaction data: ", writeData.toString("hex"));

        return this.root.DataAccount.addTxsWriteData(signer, reversedTxId, writeData, txs, feeRate);
    }

    /**
     * Checks whether we should unwrap the WSOL to SOL when claiming the swap
     *
     * @param signer
     * @param swapData
     * @private
     */
    private shouldUnwrap(signer: PublicKey, swapData: SolanaSwapData): boolean {
        return swapData.isPayOut() &&
            swapData.token.equals(this.root.Tokens.WSOL_ADDRESS) &&
            swapData.claimer.equals(signer);
    }

    /**
     * Creates transactions claiming the swap using a secret (for HTLC swaps)
     *
     * @param signer
     * @param swapData swap to claim
     * @param secret hex encoded secret pre-image to the HTLC hash
     * @param checkExpiry whether to check if the swap is already expired (trying to claim an expired swap with a secret
     *  is dangerous because we might end up revealing the secret to the counterparty without being able to claim the swap)
     * @param initAta whether to init the claimer's ATA if it doesn't exist
     * @param feeRate fee rate to use for the transaction
     * @param skipAtaCheck whether to check if ATA exists
     */
    async txsClaimWithSecret(
        signer: PublicKey,
        swapData: SolanaSwapData,
        secret: string,
        checkExpiry?: boolean,
        initAta?: boolean,
        feeRate?: string,
        skipAtaCheck?: boolean
    ): Promise<SolanaTx[]> {
        //We need to be sure that this transaction confirms in time, otherwise we reveal the secret to the counterparty
        // and won't claim the funds
        if(checkExpiry && this.root.isExpired(swapData.claimer.toString(), swapData)) {
            throw new SwapDataVerificationError("Not enough time to reliably pay the invoice");
        }
        const shouldInitAta = !skipAtaCheck && swapData.isPayOut() && !await this.root.Tokens.ataExists(swapData.claimerAta);
        if(shouldInitAta && !initAta) throw new SwapDataVerificationError("ATA not initialized");

        if(feeRate==null) feeRate = await this.getClaimFeeRate(signer, swapData);

        const action = new SolanaAction(signer, this.root);

        const shouldUnwrap = this.shouldUnwrap(signer, swapData);
        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(signer, swapData.claimer, swapData.token, swapData.claimerAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address");
            action.add(initAction);
        }
        action.add(await this.Claim(signer, swapData, secret));
        if(shouldUnwrap) action.add(this.root.Tokens.Unwrap(signer));

        this.logger.debug("txsClaimWithSecret(): creating claim transaction, swap: "+swapData.getHash()+
            " initializingAta: "+shouldInitAta+" unwrapping: "+shouldUnwrap);

        return [await action.tx(feeRate)];
    }

    /**
     * Creates transaction claiming the swap using a confirmed transaction data (for BTC on-chain swaps)
     *
     * @param signer
     * @param swapData swap to claim
     * @param blockheight blockheight of the bitcoin transaction
     * @param tx bitcoin transaction that satisfies the swap condition
     * @param vout vout of the bitcoin transaction that satisfies the swap condition
     * @param commitedHeader commited header data from btc relay (fetched internally if null)
     * @param synchronizer optional synchronizer to use in case we need to sync up the btc relay ourselves
     * @param initAta whether to initialize claimer's ATA
     * @param storageAccHolder an object holder filled in with the created data account where tx data is written
     * @param feeRate fee rate to be used for the transactions
     */
    async txsClaimWithTxData(
        signer: PublicKey | SolanaSigner,
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

        const signerKey = signer instanceof SolanaSigner ? signer.getPublicKey() : signer;

        if(feeRate==null) feeRate = await this.getClaimFeeRate(signerKey, swapData);

        const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(tx.txid, tx.blockhash);
        this.logger.debug("txsClaimWithTxData(): merkle proof computed: ", merkleProof);

        const txs: SolanaTx[] = [];
        if(commitedHeader==null) commitedHeader = await this.getCommitedHeaderAndSynchronize(
            signerKey, blockheight, swapData.getConfirmations(),
            tx.blockhash, txs, synchronizer
        );

        const storeDataKey = await this.addTxsWriteTransactionData(signer, tx, vout, feeRate, txs);
        if(storageAccHolder!=null) storageAccHolder.storageAcc = storeDataKey;

        const shouldUnwrap = this.shouldUnwrap(signerKey, swapData);
        if(shouldInitAta) {
            const initAction = this.root.Tokens.InitAta(signerKey, swapData.claimer, swapData.token, swapData.claimerAta);
            if(initAction==null) throw new SwapDataVerificationError("Invalid claimer token account address");
            await initAction.addToTxs(txs, feeRate);
        }
        const claimAction = await this.VerifyAndClaim(signerKey, swapData, storeDataKey, merkleProof, commitedHeader);
        await claimAction.addToTxs(txs, feeRate);
        if(shouldUnwrap) await this.root.Tokens.Unwrap(signerKey).addToTxs(txs, feeRate);

        this.logger.debug("txsClaimWithTxData(): creating claim transaction, swap: "+swapData.getHash()+
            " initializingAta: "+shouldInitAta+" unwrapping: "+shouldUnwrap+" num txns: "+txs.length);

        return txs;
    }

    public getClaimFeeRate(signer: PublicKey, swapData: SolanaSwapData): Promise<string> {
        const accounts: PublicKey[] = [signer];
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

    /**
     * Get the estimated solana transaction fee of the claim transaction, this fee might be negative since it
     *  includes the rebate for closing the swap PDA
     */
    public async getClaimFee(signer: PublicKey, swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+5000);

        feeRate = feeRate || await this.getClaimFeeRate(signer, swapData);

        return new BN(-this.root.ESCROW_STATE_RENT_EXEMPT+5000).add(
            this.root.Fees.getPriorityFee(this.getComputeBudget(swapData), feeRate)
        );
    }

    /**
     * Get the estimated solana transaction fee of the claim transaction in the worst case scenario in case where the
     *  ATA needs to be initialized again (i.e. adding the ATA rent exempt lamports to the fee)
     */
    public async getRawClaimFee(signer: PublicKey, swapData: SolanaSwapData, feeRate?: string): Promise<BN> {
        if(swapData==null) return new BN(5000);

        feeRate = feeRate || await this.getClaimFeeRate(signer, swapData);

        //Include rent exempt in claim fee, to take into consideration worst case cost when user destroys ATA
        return new BN(this.root.Tokens.SPL_ATA_RENT_EXEMPT+5000).add(
            this.root.Fees.getPriorityFee(this.getComputeBudget(swapData), feeRate)
        );
    }

}