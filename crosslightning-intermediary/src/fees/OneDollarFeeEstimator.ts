import {IBtcFeeEstimator} from "./IBtcFeeEstimator";
const dynamicImport = new Function('specifier', 'return import(specifier)');
const importPromise = dynamicImport('one-dollar-fee-estimator-failover');

export class OneDollarFeeEstimator implements IBtcFeeEstimator {

    estimator: any;

    receivedFee: [number, number, number, number];
    iterations: number = 0;

    host: string;
    port: number;
    username: string;
    password: string;

    startFeeEstimator() {
        console.log("Starting fee estimator worker!");

        importPromise.then(({FeeEstimator}) => {
            this.estimator = new FeeEstimator({
                mode: 'bundles', // 'txs' | 'bundles' - optional, default 'txs'
                refresh: 30, // optional, default 30 - interval in seconds, setting too low can cause unexpected errors
                rpcOptions: {
                    host: this.host,
                    port: this.port,
                    username: this.username,
                    password: this.password
                }
            });

            this.estimator.on('error', (err) => {
                console.error("Fee estimator error: ", err);
                if(err.message.startsWith("FeeEstimator worker stopped")) {
                    console.log("Restarting fee estimator worker!");
                    this.receivedFee = null;
                    this.iterations = 0;
                    this.startFeeEstimator();
                }
            });

            // receive live fee rate updates from the FeeEstimator
            this.estimator.on('fees', (fees) => {
                this.receivedFee = fees;
                this.iterations++;
            });
        });
    }

    constructor(
        host: string,
        port: number,
        username: string,
        password: string
    ) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.startFeeEstimator();

        process.on('exit', () => {
            console.log("Process exiting, stopping estimator...");
            if(this.estimator!=null) this.estimator.stop();
        });

        process.on('SIGINT', () => {
            console.log("Process exiting, stopping estimator...");
            if(this.estimator!=null) this.estimator.stop();
            process.exit();
        });
    }

    estimateFee(): Promise<number | null> {
        return Promise.resolve(this.iterations<=1 ? null : this.receivedFee[3]);
    }

}