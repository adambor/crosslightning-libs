import {AnchorProvider, Idl, Program} from "@coral-xyz/anchor";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";
import {SolanaBase, SolanaRetryPolicy} from "../base/SolanaBase";
import {SolanaProgramEvents} from "./modules/SolanaProgramEvents";

export class SolanaProgramBase<T extends Idl> extends SolanaBase {

    program: Program<T>;

    public readonly Events: SolanaProgramEvents;

    constructor(
        provider: AnchorProvider,
        programIdl: any,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFeeEstimator = new SolanaFeeEstimator(provider.connection)
    ) {
        super(provider, retryPolicy, solanaFeeEstimator);
        this.program = new Program<T>(programIdl as any, programAddress || programIdl.metadata.address, provider);

        this.Events = new SolanaProgramEvents(this);
    }

}