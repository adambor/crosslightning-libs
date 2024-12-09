import {Connection, Signer} from "@solana/web3.js";
import {AnchorProvider} from "@coral-xyz/anchor";
import {SolanaFees} from "./modules/SolanaFees";
import {SolanaBlocks} from "./modules/SolanaBlocks";
import {SolanaSlots} from "./modules/SolanaSlots";
import {SolanaTokens} from "./modules/SolanaTokens";
import {SolanaTransactions} from "./modules/SolanaTransactions";
import {SolanaAddresses} from "./modules/SolanaAddresses";
import {SolanaSignatures} from "./modules/SolanaSignatures";
import {SolanaEvents} from "./modules/SolanaEvents";
import {getLogger} from "../../utils/Utils";

export type SolanaRetryPolicy = {
    maxRetries?: number,
    delay?: number,
    exponential?: boolean,
    transactionResendInterval?: number
}

export class SolanaBase {

    public readonly SLOT_TIME = 400;
    public readonly TX_SLOT_VALIDITY = 151;

    readonly connection: Connection;
    readonly retryPolicy: SolanaRetryPolicy;

    public readonly Blocks: SolanaBlocks;
    public readonly Fees: SolanaFees;
    public readonly Slots: SolanaSlots;
    public readonly Tokens: SolanaTokens;
    public readonly Transactions: SolanaTransactions;
    public readonly Addresses: SolanaAddresses;
    public readonly Signatures: SolanaSignatures;
    public readonly Events: SolanaEvents;

    protected readonly logger = getLogger(this.constructor.name+": ");

    constructor(
        connection: Connection,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFees = new SolanaFees(connection)
    ) {
        this.connection = connection;
        this.retryPolicy = retryPolicy;

        this.Blocks = new SolanaBlocks(this);
        this.Fees = solanaFeeEstimator;
        this.Slots = new SolanaSlots(this);
        this.Tokens = new SolanaTokens(this);
        this.Transactions = new SolanaTransactions(this);
        this.Addresses = new SolanaAddresses(this);
        this.Signatures = new SolanaSignatures(this);
        this.Events = new SolanaEvents(this);
    }

}