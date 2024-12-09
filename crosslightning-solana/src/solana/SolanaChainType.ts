import {ChainType} from "crosslightning-base";
import {SolanaTx} from "./base/modules/SolanaTransactions";
import {SolanaPreFetchData, SolanaPreFetchVerification} from "./swaps/modules/SwapInit";
import {SolanaSigner} from "./wallet/SolanaSigner";
import {SolanaSwapProgram} from "./swaps/SolanaSwapProgram";
import {SolanaSwapData} from "./swaps/SolanaSwapData";
import {SolanaChainEventsBrowser} from "./events/SolanaChainEventsBrowser";
import {SolanaBtcRelay} from "./btcrelay/SolanaBtcRelay";

export type SolanaChainType = ChainType<
    "SOLANA",
    SolanaPreFetchData,
    SolanaPreFetchVerification,
    SolanaTx,
    SolanaSigner,
    SolanaSwapData,
    SolanaSwapProgram,
    SolanaChainEventsBrowser,
    SolanaBtcRelay<any>
>;
