export const btcRelayContract = {
    abi: [
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "newChainTip",
                    "type": "bytes32"
                },
                {
                    "indexed": true,
                    "internalType": "uint256",
                    "name": "startHeight",
                    "type": "uint256"
                },
                {
                    "indexed": true,
                    "internalType": "uint256",
                    "name": "forkId",
                    "type": "uint256"
                }
            ],
            "name": "ChainReorg",
            "type": "event"
        },
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "commitmentHash",
                    "type": "bytes32"
                },
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "blockHash",
                    "type": "bytes32"
                },
                {
                    "indexed": true,
                    "internalType": "uint256",
                    "name": "forkId",
                    "type": "uint256"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "indexed": false,
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "storedHeader",
                    "type": "tuple"
                }
            ],
            "name": "StoreFork",
            "type": "event"
        },
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "commitmentHash",
                    "type": "bytes32"
                },
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "blockHash",
                    "type": "bytes32"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "indexed": false,
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "storedHeader",
                    "type": "tuple"
                }
            ],
            "name": "StoreHeader",
            "type": "event"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "uint32",
                            "name": "version",
                            "type": "uint32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint32",
                            "name": "timestamp",
                            "type": "uint32"
                        },
                        {
                            "internalType": "uint32",
                            "name": "nbits",
                            "type": "uint32"
                        },
                        {
                            "internalType": "uint32",
                            "name": "nonce",
                            "type": "uint32"
                        }
                    ],
                    "internalType": "struct BTCRelay.Header",
                    "name": "blockHeader",
                    "type": "tuple"
                },
                {
                    "internalType": "uint256",
                    "name": "blockHeight",
                    "type": "uint256"
                },
                {
                    "internalType": "uint256",
                    "name": "chainWork",
                    "type": "uint256"
                },
                {
                    "internalType": "uint32",
                    "name": "lastDiffAdjustmentTime",
                    "type": "uint32"
                },
                {
                    "internalType": "uint256[10]",
                    "name": "prevBlockTimestamps",
                    "type": "uint256[10]"
                }
            ],
            "name": "setInitialParent",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes",
                    "name": "blockHeaderBytes",
                    "type": "bytes"
                },
                {
                    "internalType": "uint256",
                    "name": "forkId",
                    "type": "uint256"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "prevBlockHeader",
                    "type": "tuple"
                }
            ],
            "name": "submitForkChainHeaders",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes",
                    "name": "blockHeaderBytes",
                    "type": "bytes"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "prevBlockHeader",
                    "type": "tuple"
                }
            ],
            "name": "submitMainChainHeaders",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes",
                    "name": "blockHeaderBytes",
                    "type": "bytes"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "prevBlockHeader",
                    "type": "tuple"
                }
            ],
            "name": "submitNewForkChainHeaders",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "forkCounter",
                    "type": "uint256"
                }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "_forkCounter",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "_highScoreAndBlockHeight",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "_lastDiffAdjustmentTime",
            "outputs": [
                {
                    "internalType": "uint32",
                    "name": "",
                    "type": "uint32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "name": "_mainChain",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "name": "_ongoingForks",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "startHeight",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "_startHeight",
            "outputs": [
                {
                    "internalType": "uint32",
                    "name": "",
                    "type": "uint32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "DIFFICULTY_ADJUSTMENT_INVETVAL",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "getBlockHeight",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "uint256",
                    "name": "blockHeight",
                    "type": "uint256"
                }
            ],
            "name": "getCommitment",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "getHighScore",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "uint256",
                    "name": "forkId",
                    "type": "uint256"
                }
            ],
            "name": "getLatestForkHash",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "getLatestMainChainCommitmentHash",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "MAX_FUTURE_BLOCKTIME",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "PRUNING_FACTOR",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "TARGET_TIMESPAN",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "TARGET_TIMESPAN_DIV_4",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "TARGET_TIMESPAN_MUL_4",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [],
            "name": "UNROUNDED_MAX_TARGET",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes32",
                    "name": "reversedTxid",
                    "type": "bytes32"
                },
                {
                    "internalType": "uint256",
                    "name": "txBlockHeight",
                    "type": "uint256"
                },
                {
                    "internalType": "uint256",
                    "name": "txIndex",
                    "type": "uint256"
                },
                {
                    "internalType": "bytes",
                    "name": "merkleProof",
                    "type": "bytes"
                },
                {
                    "internalType": "uint256",
                    "name": "confirmations",
                    "type": "uint256"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "chainWork",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "reversedPrevBlockHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "merkleRoot",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data1",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data2",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct BTCRelay.HeaderInfo",
                    "name": "blockHeader",
                    "type": "tuple"
                }
            ],
            "name": "verifyTX",
            "outputs": [
                {
                    "internalType": "bool",
                    "name": "",
                    "type": "bool"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        }
    ]
};