import {SolanaSwapModule} from "../SolanaSwapModule";
import {AccountInfo, PublicKey, Signer, SystemProgram} from "@solana/web3.js";
import {IStorageManager, StorageObject} from "crosslightning-base";
import {SolanaSwapProgram} from "../SolanaSwapProgram";
import {SolanaAction} from "../../base/SolanaAction";
import {SolanaTx} from "../../base/modules/SolanaTransactions";
import {tryWithRetries} from "../../../utils/Utils";
import * as randomBytes from "randombytes";

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

export class SolanaDataAccount extends SolanaSwapModule {

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
     * Action for initialization of the data account
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
        ], SolanaDataAccount.CUCosts.DATA_CREATE, null, [accountKey]);
    }

    /**
     * Action for closing the specific data account
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
            SolanaDataAccount.CUCosts.DATA_REMOVE,
            await this.root.Fees.getFeeRate([this.provider.publicKey, publicKey])
        );
    }

    /**
     * Action for writing data to a data account, writes up to sizeLimit starting from the offset position of the
     *  provided writeData buffer
     *
     * @param accountKey account public key to write to
     * @param writeData buffer holding the write data
     * @param offset data from buffer starting at offset are written
     * @param sizeLimit maximum amount of data to be written to the data account in this action
     * @private
     * @returns {Promise<{bytesWritten: number, action: SolanaAction}>} bytes written to the data account & action
     */
    private async WriteData(
        accountKey: Signer,
        writeData: Buffer,
        offset: number,
        sizeLimit: number
    ): Promise<{bytesWritten: number, action: SolanaAction}> {
        const writeLen = Math.min(writeData.length-offset, sizeLimit);

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
                SolanaDataAccount.CUCosts.DATA_WRITE
            )
        };
    }

    constructor(root: SolanaSwapProgram, storage: IStorageManager<StoredDataAccount>) {
        super(root);
        this.storage = storage;
    }

    /**
     * Saves data account to the storage, the storage is required such that we are able to close the accounts later
     *  manually in case the claim doesn't happen (expires due to fees, etc.)
     *
     * @param publicKey
     * @private
     */
    private saveDataAccount(publicKey: PublicKey): Promise<void> {
        return this.storage.saveData(publicKey.toBase58(), new StoredDataAccount(publicKey));
    }

    /**
     * Initializes the data account handler, loads the existing data accounts which should be checked and closed
     */
    public async init() {
        await this.storage.init();
        const loadedData = await this.storage.loadData(StoredDataAccount);
        this.logger.info("init(): initialized & loaded stored data accounts, count: "+loadedData.length);
    }

    /**
     * Removes data account from the list of accounts that should be checked for reclaiming the locked SOL, this should
     *  be called after a batch of transactions claiming the swap was confirmed
     *
     * @param publicKey
     */
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

        if(closePublicKeys.length===0) {
            this.logger.debug("sweepDataAccounts(): no old data accounts found, no need to close any!");
            return;
        }

        this.logger.debug("sweepDataAccounts(): closing old data accounts: ", closePublicKeys);

        let txns: SolanaTx[] = [];
        for(let publicKey of closePublicKeys) {
            await (await this.CloseDataAccount(publicKey)).addToTxs(txns);
        }

        const result = await this.root.Transactions.sendAndConfirm(txns, true, null, true);

        this.logger.info("sweepDataAccounts(): old data accounts closed: "+
            closePublicKeys.map(pk => pk.toBase58()).join());

        for(let publicKey of closePublicKeys) {
            await this.removeDataAccount(publicKey);
        }
    }

    /**
     * Adds the transactions writing (and also initializing if it doesn't exist) data to the data account
     *
     * @param reversedTxId reversed btc tx id is used to derive the data account address
     * @param writeData full data to be written to the data account
     * @param txs solana transactions array, where txns for writing & initializing will be added
     * @param feeRate fee rate to use for the transactions
     */
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
            this.logger.debug("addTxsWriteData(): Write partial data ("+pointer+" .. "+(pointer+bytesWritten)+")/"+writeData.length+
                " key: "+txDataKey.publicKey.toBase58());
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
            this.logger.debug("addTxsWriteData(): Write partial data ("+pointer+" .. "+(pointer+bytesWritten)+")/"+writeData.length+
                " key: "+txDataKey.publicKey.toBase58());
            pointer += bytesWritten;
            await action.addToTxs(txs, feeRate);
        }

        return txDataKey.publicKey;
    }

}