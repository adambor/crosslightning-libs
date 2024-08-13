import {AnchorProvider} from "@coral-xyz/anchor";
import {Signer} from "@solana/web3.js";
import {SolanaBase, SolanaRetryPolicy} from "./SolanaBase";
import {getLogger} from "../../utils/Utils";

export class SolanaModule {

    protected readonly provider: AnchorProvider & {signer?: Signer};
    protected readonly retryPolicy: SolanaRetryPolicy;
    protected readonly root: SolanaBase;

    protected readonly logger = getLogger(this.constructor.name+": ");

    constructor(
        root: SolanaBase
    ) {
        this.provider = root.provider;
        this.retryPolicy = root.retryPolicy;
        this.root = root;
    }

}