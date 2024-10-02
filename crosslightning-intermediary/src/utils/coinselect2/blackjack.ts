import {CoinselectAddressTypes, CoinselectTxInput, CoinselectTxOutput, utils} from "./utils";

// add inputs until we reach or surpass the target value (or deplete)
// worst-case: O(n)
export function blackjack (
    utxos: CoinselectTxInput[],
    outputs: CoinselectTxOutput[],
    feeRate: number,
    type: CoinselectAddressTypes,
    requiredInputs?: CoinselectTxInput[]
): {
    inputs?: CoinselectTxInput[],
    outputs?: CoinselectTxOutput[],
    fee: number
} {
    if (!isFinite(utils.uintOrNaN(feeRate))) return null;

    let bytesAccum = utils.transactionBytes([], outputs, type);
    let inAccum = 0;
    const inputs = [];

    if(requiredInputs!=null) for(let utxo of requiredInputs) {
        const {length: utxoBytes} = utils.inputBytes(utxo);
        const utxoValue = utils.uintOrNaN(utxo.value);

        bytesAccum += utxoBytes;
        inAccum += utxoValue;
        inputs.push(utxo);
    }

    const outAccum = utils.sumOrNaN(outputs);
    const threshold = utils.dustThreshold({type});

    for (let i = 0; i < utxos.length; ++i) {
        const input = utxos[i];
        const {length: inputBytes} = utils.inputBytes(input);
        const fee = feeRate * (bytesAccum + inputBytes);
        const inputValue = utils.uintOrNaN(input.value);

        // would it waste value?
        if ((inAccum + inputValue) > (outAccum + fee + threshold)) continue;

        bytesAccum += inputBytes;
        inAccum += inputValue;
        inputs.push(input);

        // go again?
        if (inAccum < outAccum + fee) continue;

        return utils.finalize(inputs, outputs, feeRate, type);
    }

    return { fee: feeRate * bytesAccum };
}
