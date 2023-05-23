import {BigNumber, providers, Transaction, UnsignedTransaction, utils, Wallet} from "ethers";
import {Deferrable} from "@ethersproject/properties/lib";
import * as fs from "fs/promises";

const WAIT_BEFORE_BUMP = 15*1000;
const MIN_FEE_INCREASE = BigNumber.from(10*1000000000);

export class OverridenStaticJsonRpcProvider extends providers.StaticJsonRpcProvider {

    private waitTxs: {
        [txId: string]: {
            resolve: (tx: providers.TransactionReceipt) => void
        }
    } = {};

    constructor(rpcUrl: string, chainId: number) {
        super(rpcUrl, {
            chainId,
            name: "EVM"
        });
    }

    txConfirmed(originalTransactionHash: string, replacement: providers.TransactionReceipt) {
        if(this.waitTxs[originalTransactionHash]==null) return;
        this.waitTxs[originalTransactionHash].resolve(replacement);
        delete this.waitTxs[originalTransactionHash];
    }

    async waitForTransaction(transactionHash: string, confirmations?: number, timeout?: number): Promise<providers.TransactionReceipt> {
        const receipt = await this.getTransactionReceipt(transactionHash);
        if(receipt!=null) return receipt;

        const timestampStart = Date.now();
        const tx = await new Promise<providers.TransactionReceipt>((resolve, reject) => {
            let timeoutObj;
            if(timeout>0) timeoutObj = setTimeout(() => {
                if(this.waitTxs[transactionHash]!=null) delete this.waitTxs[transactionHash];
                reject(new Error("Timed out"))
            }, timeout);
            this.waitTxs[transactionHash] = {
                resolve: (tx: providers.TransactionReceipt) => {
                    if(timeoutObj!=null) clearTimeout(timeoutObj);
                    resolve(tx);
                }
            };
        });

        const timeElapsed = Date.now()-timestampStart;

        if(confirmations==null || confirmations===1) {
            return tx;
        } else {
            return await super.waitForTransaction(tx.transactionHash, confirmations, timeout-timeElapsed);
        }
    }

}

export class EVMWallet extends Wallet {

    private readonly chainId: number;
    private pendingTxs: {
        [nonce: string]: {
            txs: Transaction[],
            lastBumped: number
        }
    } = {};
    private txMap: {
        [txId: string]: number
    } = {};
    private confirmedNonce: number;
    private pendingNonce: number;

    private feeBumper: any;
    private stopped: boolean = false;

    private readonly directory: string;

    private readonly boundTransactionListener: (transaction: providers.TransactionReceipt) => void;

    constructor(privateKey: string, rpcUrl: string, chainId: number, directory: string) {
        super(privateKey, new OverridenStaticJsonRpcProvider(rpcUrl, chainId));
        this.directory = directory;
        this.chainId = chainId;
        this.boundTransactionListener = this.transactionListener.bind(this);
    }

    transactionListener(transaction: providers.TransactionReceipt) {
        const provider: OverridenStaticJsonRpcProvider = this.provider as OverridenStaticJsonRpcProvider;
        const nonce = this.txMap[transaction.transactionHash];
        if(nonce==null) return;
        const data = this.pendingTxs[nonce.toString()];
        for(let tx of data.txs) {
            if(this.txMap[tx.hash]!=null) delete this.txMap[tx.hash];
            this.provider.off(tx.hash, this.boundTransactionListener);
        }
        delete this.pendingTxs[nonce.toString()];
        this.confirmedNonce = nonce;
        provider.txConfirmed(data.txs[0].hash, transaction);
        this.save();
    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.directory)
        } catch (e) {}

        const txCount = await this.provider.getTransactionCount(this.address, "latest");
        this.confirmedNonce = txCount-1;
        this.pendingNonce = txCount-1;

        const res = await fs.readFile(this.directory+"/txs.json").catch(e => console.error(e));
        if(res!=null) {
            const pendingTxs: {
                [nonce: string]: {
                    txs: string[],
                    lastBumped: number
                }
            } = JSON.parse((res as Buffer).toString());

            for(let nonceStr in pendingTxs) {
                const nonce = parseInt(nonceStr);
                if(nonce>txCount) {
                    if(this.pendingNonce<nonce) {
                        this.pendingNonce = nonce;
                    }
                    this.pendingTxs[nonceStr] = {
                        txs: pendingTxs[nonceStr].txs.map(tx => {
                            return utils.parseTransaction(tx)
                        }),
                        lastBumped: pendingTxs[nonceStr].lastBumped
                    };
                    for(let tx of this.pendingTxs[nonceStr].txs) {
                        this.txMap[tx.hash] = tx.nonce;
                        this.provider.on(tx.hash, this.boundTransactionListener);
                    }
                }
            }
        }

        let func;
        func = async () => {
            try {
                let _gasPrice: BigNumber = null;

                for(let nonceStr in this.pendingTxs) {
                    const data = this.pendingTxs[nonceStr];
                    if(data.lastBumped<Date.now()-WAIT_BEFORE_BUMP) {
                        const lastTx = data.txs[data.txs.length-1];
                        if(_gasPrice==null) _gasPrice = await this.provider.getGasPrice();
                        const feeDifference = _gasPrice.sub(lastTx.gasPrice);
                        const newTx = utils.shallowCopy(lastTx);
                        if(feeDifference.lt(MIN_FEE_INCREASE)) {
                            newTx.gasPrice = lastTx.gasPrice.add(MIN_FEE_INCREASE);
                        } else {
                            newTx.gasPrice = _gasPrice;
                        }

                        delete newTx.r;
                        delete newTx.s;
                        delete newTx.v;
                        delete newTx.hash;
                        delete newTx.from;

                        const signedTx = await this.signTransaction(newTx);

                        if(this.pendingTxs[nonceStr]==null) continue;

                        const parsed = utils.parseTransaction(signedTx);

                        data.txs.push(parsed);
                        data.lastBumped = Date.now();
                        this.save();

                        this.txMap[parsed.hash] = parsed.nonce;
                        this.provider.on(parsed.hash, this.boundTransactionListener);

                        await this.provider.sendTransaction(signedTx).catch(e => console.error(e));
                    }
                }
            } catch (e) {
                console.error(e);
            }

            if(this.stopped) return;

            this.feeBumper = setTimeout(func, 1000);
        };

        func();

    }

    stop() {
        this.stopped = true;
        if(this.feeBumper!=null) {
            clearTimeout(this.feeBumper);
            this.feeBumper = null;
        }
        for(let nonceStr in this.pendingTxs) {
            for(let tx of this.pendingTxs[nonceStr].txs) {
                this.provider.removeAllListeners(tx.hash);
            }
        }
    }

    private priorSavePromise: Promise<void>;
    private saveCount: number = 0;

    async save() {
        const pendingTxs: {
            [nonce: string]: {
                txs: string[],
                lastBumped: number
            }
        } = {};
        for(let nonceStr in this.pendingTxs) {
            const txs = this.pendingTxs[nonceStr].txs;
            pendingTxs[nonceStr] = {
                txs: txs.map(tx => {
                    const signature = {
                        r: tx.r,
                        s: tx.s,
                        v: tx.v
                    };
                    const txCpy = utils.shallowCopy(tx);
                    delete txCpy.r;
                    delete txCpy.s;
                    delete txCpy.v;
                    delete txCpy.hash;
                    delete txCpy.from;
                    return utils.serializeTransaction(txCpy, signature);
                }),
                lastBumped: this.pendingTxs[nonceStr].lastBumped
            };
        }
        const requiredSaveCount = ++this.saveCount;
        if(this.priorSavePromise!=null) {
            await this.priorSavePromise;
        }
        if(requiredSaveCount===this.saveCount) {
            this.priorSavePromise = fs.writeFile(this.directory+"/txs.json", JSON.stringify(pendingTxs));
            await this.priorSavePromise;
        }
    }

    async signTransaction(transaction: providers.TransactionRequest): Promise<string> {
        transaction.from = this.address;
        transaction.chainId = this.chainId;
        return await super.signTransaction(transaction);
    }

    async sendTransaction(transaction: Deferrable<providers.TransactionRequest>): Promise<providers.TransactionResponse> {
        const gasPrice: BigNumber = await this.provider.getGasPrice();
        //const gasPrice: BigNumber = BigNumber.from(2*1000000000);
        transaction.gasPrice = gasPrice;
        this.pendingNonce++;
        transaction.nonce = BigNumber.from(this.pendingNonce);

        const tx: providers.TransactionRequest = {};
        for(let key in transaction) {
            if(transaction[key] instanceof Promise) {
                tx[key] = await transaction[key];
            } else {
                tx[key] = transaction[key];
            }
        }

        const signedTx = await this.signTransaction(tx);

        const parsed = utils.parseTransaction(signedTx);

        this.pendingTxs[transaction.nonce.toString()] = {
            txs: [parsed],
            lastBumped: Date.now()
        };
        this.save();

        this.txMap[parsed.hash] = parsed.nonce;
        this.provider.on(parsed.hash, this.boundTransactionListener);

        return await this.provider.sendTransaction(signedTx);
    }

}
