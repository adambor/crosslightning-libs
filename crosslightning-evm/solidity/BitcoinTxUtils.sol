
library BitcoinTxUtils {

    function verifyTransaction(bytes memory txData, uint256 vout, bool nonced) internal view returns (bytes32 txId, bytes32 txoHash, uint256 sequence, uint256 locktime) {

        uint256 nSequenceMisses;

        assembly {
            function uint32LEtoBE(input) -> output {
                output := or(shr(8, and(input, 0xFF00FF00)), shl(8, and(input, 0x00FF00FF)))
                output := or(shr(16, and(output, 0xFFFF0000)), shl(16, and(output, 0x0000FFFF)))
            }

            function readVarInt(inputBytes) -> inputCount, inputByteCount {
                inputByteCount := 1

                switch gt(shr(248,inputBytes), 0xFC) case 1 {
                    inputByteCount := shl(sub(shr(248,inputBytes), 0xFC), 0x01)
                    for
                        { let index := 0 }
                        lt(index, inputByteCount)
                        { index := add(index, 1) }
                    {
                        inputCount := shl(8, inputCount)
                        inputCount := or(
                            inputCount,
                            and(shr(sub(240, mul(index, 8)), inputBytes), 0xFF)
                        )
                    }
                    inputByteCount := add(inputByteCount, 1)
                } default {
                    inputCount := and(shr(248,inputBytes), 0xFF)
                }
            }

            //32 byte length prefix + 4 bytes of version
            let offset := add(txData,36)

            let inputCount, inputByteCount := readVarInt(mload(offset))
            offset := add(offset, inputByteCount)

            for
                { let index := 0 }
                lt(index, inputCount)
                { index := add(index, 1) }
            {
                offset := add(offset, 36) //Utxo and index

                let scriptLen, scripLenSize := readVarInt(mload(offset))

                offset := add(offset, add(scripLenSize, scriptLen))

                //TODO: Check nSequence
                let nSequence := and(shr(224,mload(offset)), 0xFFFFFF00)
                switch index case 0x00 {
                    sequence := nSequence
                } default {
                    nSequenceMisses := add(nSequenceMisses, iszero(eq(sequence, nSequence)))
                }

                offset := add(offset, 4)
            }

            let outputCount, outputByteCount := readVarInt(mload(offset))

            offset := add(offset, outputByteCount)

            for
                { let index := 0 }
                lt(index, outputCount)
                { index := add(index, 1) }
            {
                let amount := shr(192, mload(offset))

                offset := add(offset, 8)

                let scriptLen, scripLenSize := readVarInt(mload(offset))

                offset := add(offset, scripLenSize)

                switch eq(index, vout) case 0x01 {
                    let startIndex := sub(offset, 32)
                    let cache := mload(startIndex)
                    mstore(startIndex, amount)
                    txoHash := keccak256(add(startIndex, 24), add(scriptLen, 8))
                    mstore(startIndex, cache)
                }

                offset := add(offset, scriptLen)
            }
            
            locktime := uint32LEtoBE(shr(224,mload(offset)))
            sequence := uint32LEtoBE(sequence)

            let length := mload(txData)

            pop(staticcall(gas(), 0x02, add(txData, 32), length, 0x00, 32)) //first hash
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            txId := mload(0x00)
        }

        if(nonced) require(nSequenceMisses==0, "Invalid nSequence"); 
    }

}
