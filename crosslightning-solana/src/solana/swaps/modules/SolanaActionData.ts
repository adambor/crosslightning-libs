import {SolanaSwapModule} from "./SolanaSwapModule";
import {AccountInfo, PublicKey, Signer, SystemProgram} from "@solana/web3.js";
import {IStorageManager, StorageObject} from "crosslightning-base";
import {SolanaSwapProgram} from "../SolanaSwapProgram";
import {SolanaAction} from "../../base/SolanaAction";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {getLogger} from "../Utils";
import {tryWithRetries} from "../../../utils/RetryUtils";
import {randomBytes} from "crypto";

const logger = getLogger("SolanaActionData: ");

export class StoredDataAccount implements StorageObject {

    accountKey: PublicKey;

    constructor(accountKey: PublicKey);
    constructor(data: any);

    constructor(accountKeyOrData: PublicKey | any) {
        if(accountKeyOrData instanceof PublicKey) {
            this.accountKey = accountKeyOrData;
        } else {
            this.accountKey = new PublicKey(accountKeyOrData.accountKey);
        }
    }

    serialize(): any {
        return {
            accountKey: this.accountKey.toBase58()
        }
    }

}

export class SolanaActionData extends SolanaSwapModule {

    readonly SwapTxDataAlt = this.root.keypair(
        (reversedTxId: Buffer, signer: Signer) => [Buffer.from(signer.secretKey), reversedTxId]
    );
    readonly SwapTxDataAltBuffer = this.root.keypair((reversedTxId: Buffer, secret: Buffer) => [secret, reversedTxId]);

    readonly storage: IStorageManager<StoredDataAccount>;

    private static readonly CUCosts = {
        DATA_REMOVE: 50000,
        DATA_CREATE_AND_WRITE: 15000,
        DATA_CREATE: 5000,
        DATA_WRITE: 15000
    };

    /**
     * Adds instructions for initialization of data account
     *
     * @param accountKey
     * @param dataLength
     * @private
     */
    private async InitDataAccount(
        accountKey: Signer,
        dataLength: number
    ): Promise<SolanaAction> {
        const accountSize = 32+dataLength;
        const lamportsDeposit = await tryWithRetries(
            () => this.provider.connection.getMinimumBalanceForRentExemption(accountSize),
            this.retryPolicy
        );

        return new SolanaAction(this.root, [
            SystemProgram.createAccount({
                fromPubkey: this.provider.publicKey,
                newAccountPubkey: accountKey.publicKey,
                lamports: lamportsDeposit,
                space: accountSize,
                programId: this.program.programId
            }),
            await this.program.methods
                .initData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: accountKey.publicKey
                })
                .instruction(),
        ], SolanaActionData.CUCosts.DATA_CREATE, null, [accountKey]);
    }

    /**
     * Returns transactions for closing the specific data account
     *
     * @param publicKey
     */
    private async CloseDataAccount(publicKey: PublicKey): Promise<SolanaAction> {
        return new SolanaAction(
            this.root,
            await this.program.methods
                .closeData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: publicKey
                })
                .instruction(),
            SolanaActionData.CUCosts.DATA_REMOVE,
            await this.root.Fees.getFeeRate([this.provider.publicKey, publicKey])
        );
    }

    /**
     * Adds instructions for writting data to a specific account
     *
     * @param accountKey
     * @param writeData
     * @param offset
     * @param sizeLimit
     * @private
     * @returns {number} bytes written to the data account
     */
    private async WriteData(
        accountKey: Signer,
        writeData: Buffer,
        offset: number,
        sizeLimit: number
    ): Promise<{bytesWritten: number, action: SolanaAction}> {
        const writeLen = Math.min(writeData.length-offset, sizeLimit);

        logger.debug("addIxsWriteData(): Write partial tx data ("+offset+" .. "+(offset+writeLen)+")/"+writeData.length+
            " key: "+accountKey.publicKey.toBase58());

        return {
            bytesWritten: writeLen,
            action: new SolanaAction(this.root,
                await this.program.methods
                    .writeData(offset, writeData.slice(offset, offset+writeLen))
                    .accounts({
                        signer: this.provider.publicKey,
                        data: accountKey.publicKey
                    })
                    .instruction(),
                SolanaActionData.CUCosts.DATA_WRITE
            )
        };
    }

    constructor(root: SolanaSwapProgram, storage: IStorageManager<StoredDataAccount>) {
        super(root);
        this.storage = storage;
    }

    private saveDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.saveData(publicKey.toBase58(), new StoredDataAccount(publicKey));
    }

    public async init() {
        await this.storage.init();
        await this.storage.loadData(StoredDataAccount);
    }

    public removeDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.removeData(publicKey.toBase58());
    }

    /**
     * Sweeps all old data accounts, reclaiming the SOL locked in the PDAs
     */
    public async sweepDataAccounts() {
        const closePublicKeys: PublicKey[] = [];
        for(let key in this.storage.data) {
            const publicKey = new PublicKey(this.storage.data[key].accountKey);

            try {
                const fetchedDataAccount: AccountInfo<Buffer> = await this.provider.connection.getAccountInfo(publicKey);
                if(fetchedDataAccount==null) {
                    await this.removeDataAccount(publicKey);
                    continue;
                }
                closePublicKeys.push(publicKey);
            } catch (e) {}
        }

        logger.debug("sweepDataAccounts(): closing old data accounts: ", closePublicKeys);

        let txns: SolanaTx[] = [];
        for(let publicKey of closePublicKeys) {
            await (await this.CloseDataAccount(publicKey)).addToTxs(txns);
        }

        const result = await this.root.Transactions.sendAndConfirm(txns, true, null, true);

        logger.info("sweepDataAccounts(): old data accounts closed: ", closePublicKeys);

        for(let publicKey of closePublicKeys) {
            await this.removeDataAccount(publicKey);
        }
    }

    public async addTxsWriteData(
        reversedTxId: Buffer,
        writeData: Buffer,
        txs: SolanaTx[],
        feeRate: string
    ): Promise<PublicKey> {
        let txDataKey: Signer;
        let fetchedDataAccount: AccountInfo<Buffer> = null;
        if(this.provider.signer!=null) {
            txDataKey = this.SwapTxDataAlt(reversedTxId, this.provider.signer);
            fetchedDataAccount = await tryWithRetries<AccountInfo<Buffer>>(
                () => this.provider.connection.getAccountInfo(txDataKey.publicKey),
                this.retryPolicy
            );
        } else {
            const secret = randomBytes(32);
            txDataKey = this.SwapTxDataAltBuffer(reversedTxId, secret);
        }

        let pointer = 0;
        if(fetchedDataAccount==null) {
            const action = new SolanaAction(this.root);
            action.add(await this.InitDataAccount(txDataKey, writeData.length));
            const {
                bytesWritten,
                action: writeAction
            } = await this.WriteData(txDataKey, writeData, pointer, 420);
            pointer += bytesWritten;
            action.add(writeAction);

            await action.addToTxs(txs, feeRate);
            await this.saveDataAccount(txDataKey.publicKey);
        }

        while(pointer<writeData.length) {
            const {
                bytesWritten,
                action
            } = await this.WriteData(txDataKey, writeData, pointer, 950);
            pointer += bytesWritten;
            await action.addToTxs(txs, feeRate);
        }

        return txDataKey.publicKey;
    }

}