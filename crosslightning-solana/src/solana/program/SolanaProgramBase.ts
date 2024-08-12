import {AnchorProvider, Idl, Program} from "@coral-xyz/anchor";
import {SolanaFeeEstimator} from "../../utils/SolanaFeeEstimator";
import {SolanaBase, SolanaRetryPolicy} from "../base/SolanaBase";
import {SolanaProgramEvents} from "./modules/SolanaProgramEvents";
import {Keypair, PublicKey} from "@solana/web3.js";
import {createHash} from "crypto";

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

    public pda(seed: string): PublicKey;
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

    public keypair<T extends Array<any>>(func: (...args: T) => Buffer[]): (...args: T) => Keypair {
        return (...args: T) => {
            const res = func(...args);
            const buff = createHash("sha256").update(Buffer.concat(res)).digest();
            return Keypair.fromSeed(buff);
        }
    }

}