import {AnchorProvider, Idl, Program} from "@coral-xyz/anchor";
import {SolanaFees} from "../base/modules/SolanaFees";
import {SolanaBase, SolanaRetryPolicy} from "../base/SolanaBase";
import {SolanaProgramEvents} from "./modules/SolanaProgramEvents";
import {Keypair, PublicKey} from "@solana/web3.js";
import * as createHash from "create-hash";
import {Buffer} from "buffer";

/**
 * Base class providing program specific utilities
 */
export class SolanaProgramBase<T extends Idl> extends SolanaBase {

    program: Program<T>;

    public readonly Events: SolanaProgramEvents<T>;

    constructor(
        provider: AnchorProvider,
        programIdl: any,
        programAddress?: string,
        retryPolicy?: SolanaRetryPolicy,
        solanaFeeEstimator: SolanaFees = new SolanaFees(provider.connection)
    ) {
        super(provider, retryPolicy, solanaFeeEstimator);
        this.program = new Program<T>(programIdl as any, programAddress || programIdl.metadata.address, provider);

        this.Events = new SolanaProgramEvents(this);
    }

    /**
     * Derives static PDA address from the seed
     *
     * @param seed
     */
    public pda(seed: string): PublicKey;
    /**
     * Returns a function for deriving a dynamic PDA address from seed + dynamic arguments
     *
     * @param seed
     * @param func function translating the function argument to Buffer[]
     */
    public pda<T extends Array<any>>(seed: string, func: (...args: T) => Buffer[]): (...args: T) => PublicKey;
    public pda<T extends Array<any>>(seed: string, func?: (...args: T) => Buffer[]): PublicKey | ((...args: T) => PublicKey) {
        if(func==null) {
            return PublicKey.findProgramAddressSync(
                [Buffer.from(seed)],
                this.program.programId
            )[0];
        }
        return (...args: T) => {
            const res = func(...args);
            return PublicKey.findProgramAddressSync(
                [Buffer.from(seed)].concat(res),
                this.program.programId
            )[0]
        }
    }
    /**
     * Returns a function for deriving a dynamic deterministic keypair from dynamic arguments
     *
     * @param func function translating the function argument to Buffer[] to be used for deriving the keypair
     */
    public keypair<T extends Array<any>>(func: (...args: T) => Buffer[]): (...args: T) => Keypair {
        return (...args: T) => {
            const res = func(...args);
            const buff = createHash("sha256").update(Buffer.concat(res)).digest();
            return Keypair.fromSeed(buff);
        }
    }

}