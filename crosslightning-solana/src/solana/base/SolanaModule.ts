import {Connection} from "@solana/web3.js";
import {SolanaBase, SolanaRetryPolicy} from "./SolanaBase";
import {getLogger} from "../../utils/Utils";

export class SolanaModule {

    protected readonly connection: Connection;
    protected readonly retryPolicy: SolanaRetryPolicy;
    protected readonly root: SolanaBase;

    protected readonly logger = getLogger(this.constructor.name+": ");

    constructor(
        root: SolanaBase
    ) {
        this.connection = root.connection;
        this.retryPolicy = root.retryPolicy;
        this.root = root;
    }

}