import {IBtcFeeEstimator} from "./IBtcFeeEstimator";
const dynamicImport = new Function('specifier', 'return import(specifier)');
const importPromise = dynamicImport('@samouraiwallet/one-dollar-fee-estimator');

export class OneDollarFeeEstimator implements IBtcFeeEstimator {

    estimator: any;

    receivedFee: [number, number, number, number];
    iterations: number = 0;

    constructor(
        host: string,
        port: number,
        username: string,
        password: string
    ) {
        importPromise.then(({FeeEstimator}) => {
            this.estimator = new FeeEstimator({
                mode: 'bundles', // 'txs' | 'bundles' - optional, default 'txs'
                refresh: 30, // optional, default 30 - interval in seconds, setting too low can cause unexpected errors
                rpcOptions: {
                    host,
                    port,
                    username,
                    password
                }
            });

            this.estimator.on('error', (err) => {
                console.error("Fee estimator error: ", err)
            });

            // receive live fee rate updates from the FeeEstimator
            this.estimator.on('fees', (fees) => {
                this.receivedFee = fees;
                this.iterations++;
            });

            process.on('exit', () => {
                console.log("Process exiting, stopping estimator...");
                this.estimator.stop()
            });

            process.on('SIGINT', () => {
                console.log("Process exiting, stopping estimator...");
                this.estimator.stop()
            });
        });
    }

    estimateFee(): Promise<number | null> {
        return Promise.resolve(this.iterations<=1 ? null : this.receivedFee[3]);
    }

}