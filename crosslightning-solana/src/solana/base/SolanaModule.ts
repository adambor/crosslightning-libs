import {AnchorProvider} from "@coral-xyz/anchor";
import {Signer} from "@solana/web3.js";
import {SolanaBase, SolanaRetryPolicy} from "./SolanaBase";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";


export class SolanaModule {

    protected readonly provider: AnchorProvider & {signer?: Signer};
    protected readonly retryPolicy: SolanaRetryPolicy;
    protected readonly solanaFeeEstimator: SolanaFeeEstimator;
    protected readonly root: SolanaBase;

    constructor(
        root: SolanaBase
    ) {
        this.provider = root.provider;
        this.solanaFeeEstimator = root.solanaFeeEstimator;
        this.retryPolicy = root.retryPolicy;
        this.root = root;
    }

}