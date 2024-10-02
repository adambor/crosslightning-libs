import {accumulative} from "./accumulative"
import {blackjack} from "./blackjack"
import {CoinselectAddressTypes, CoinselectTxInput, CoinselectTxOutput, utils} from "./utils"
import * as BN from "bn.js";
import {shuffle} from "../Utils";

// order by descending value, minus the inputs approximate fee
function utxoScore (x, feeRate) {
    return x.value - (feeRate * utils.inputBytes(x).length)
}

function utxoFeePPM(utxo: CoinselectTxInput, feeRate: number): number {
    return new BN(utxo.value).mul(new BN(1000000)).div(new BN(Math.ceil(feeRate * utils.inputBytes(utxo).length))).toNumber();
}

/**
 * Runs a coinselection algorithm on given inputs, outputs and fee rate
 *
 * @param utxos Utxo pool to select additional inputs from
 * @param outputs Outputs of the transaction
 * @param feeRate Feerate in sats/vB
 * @param changeType Change address type
 * @param requiredInputs Utxos that need to be included as inputs to the transaction
 * @param randomize Randomize the UTXO order before running the coinselection algorithm
 */
export function coinSelect (
    utxos: CoinselectTxInput[],
    outputs: CoinselectTxOutput[],
    feeRate: number,
    changeType: CoinselectAddressTypes,
    requiredInputs?: CoinselectTxInput[],
    randomize?: boolean
): {
    inputs?: CoinselectTxInput[],
    outputs?: CoinselectTxOutput[],
    fee: number
} {
    if(randomize) {
        shuffle(utxos);
    } else {
        utxos.sort((a, b) => utxoScore(b, feeRate) - utxoScore(a, feeRate));
    }

    // attempt to use the blackjack strategy first (no change output)
    let base = blackjack(utxos, outputs, feeRate, changeType, requiredInputs);
    if (base.inputs) return base;

    // else, try the accumulative strategy
    return accumulative(utxos, outputs, feeRate, changeType, requiredInputs);
}
