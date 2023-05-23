export const swapContract = {
    abi: [
        {
            "inputs": [
                {
                    "internalType": "contract BTCRelay",
                    "name": "_btcRelay",
                    "type": "address"
                }
            ],
            "stateMutability": "nonpayable",
            "type": "constructor"
        },
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "offerer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "claimer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "paymentHash",
                    "type": "bytes32"
                },
                {
                    "indexed": false,
                    "internalType": "bytes32",
                    "name": "secret",
                    "type": "bytes32"
                }
            ],
            "name": "Claim",
            "type": "event"
        },
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "offerer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "claimer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "paymentHash",
                    "type": "bytes32"
                },
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "indexed": false,
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "data",
                    "type": "tuple"
                },
                {
                    "indexed": false,
                    "internalType": "bytes32",
                    "name": "txoHash",
                    "type": "bytes32"
                }
            ],
            "name": "Initialize",
            "type": "event"
        },
        {
            "anonymous": false,
            "inputs": [
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "offerer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "address",
                    "name": "claimer",
                    "type": "address"
                },
                {
                    "indexed": true,
                    "internalType": "bytes32",
                    "name": "paymentHash",
                    "type": "bytes32"
                }
            ],
            "name": "Refund",
            "type": "event"
        },
        {
            "inputs": [],
            "name": "SECURITY_DEPOSIT",
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
                    "internalType": "address",
                    "name": "who",
                    "type": "address"
                },
                {
                    "internalType": "address",
                    "name": "token",
                    "type": "address"
                }
            ],
            "name": "balanceOf",
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
                    "internalType": "address",
                    "name": "",
                    "type": "address"
                },
                {
                    "internalType": "address",
                    "name": "",
                    "type": "address"
                }
            ],
            "name": "balances",
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
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                },
                {
                    "internalType": "bytes32",
                    "name": "secret",
                    "type": "bytes32"
                }
            ],
            "name": "claimer_claim",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                },
                {
                    "internalType": "uint256",
                    "name": "vout",
                    "type": "uint256"
                },
                {
                    "internalType": "bytes",
                    "name": "txData",
                    "type": "bytes"
                },
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "blockheight",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "txPos",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes",
                            "name": "merkleProof",
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
                            "name": "committedHeader",
                            "type": "tuple"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.TransactionProof",
                    "name": "proof",
                    "type": "tuple"
                }
            ],
            "name": "claimer_claimWithTxData",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "name": "commitments",
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
                    "internalType": "address",
                    "name": "token",
                    "type": "address"
                },
                {
                    "internalType": "uint256",
                    "name": "amount",
                    "type": "uint256"
                }
            ],
            "name": "deposit",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "bytes32",
                    "name": "paymentHash",
                    "type": "bytes32"
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
            "inputs": [
                {
                    "internalType": "address",
                    "name": "who",
                    "type": "address"
                },
                {
                    "internalType": "address",
                    "name": "token",
                    "type": "address"
                }
            ],
            "name": "getReputation",
            "outputs": [
                {
                    "components": [
                        {
                            "internalType": "uint256",
                            "name": "success",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "coopClose",
                            "type": "uint256"
                        },
                        {
                            "internalType": "uint256",
                            "name": "failed",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.Reputation[3]",
                    "name": "",
                    "type": "tuple[3]"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "address",
                    "name": "token",
                    "type": "address"
                }
            ],
            "name": "myBalance",
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
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                },
                {
                    "components": [
                        {
                            "internalType": "bytes32",
                            "name": "r",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "s",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "vAndTimeout",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.Signature",
                    "name": "signature",
                    "type": "tuple"
                },
                {
                    "internalType": "bytes32",
                    "name": "txoHash",
                    "type": "bytes32"
                }
            ],
            "name": "offerer_claimInit",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                },
                {
                    "components": [
                        {
                            "internalType": "bytes32",
                            "name": "r",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "s",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "vAndTimeout",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.Signature",
                    "name": "signature",
                    "type": "tuple"
                },
                {
                    "internalType": "bytes32",
                    "name": "txoHash",
                    "type": "bytes32"
                }
            ],
            "name": "offerer_init",
            "outputs": [
                {
                    "internalType": "bytes32",
                    "name": "",
                    "type": "bytes32"
                }
            ],
            "stateMutability": "payable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct[]",
                    "name": "payReqs",
                    "type": "tuple[]"
                },
                {
                    "internalType": "bool",
                    "name": "payIn",
                    "type": "bool"
                }
            ],
            "name": "offerer_multi_refund",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct[]",
                    "name": "payReqs",
                    "type": "tuple[]"
                },
                {
                    "internalType": "bool",
                    "name": "payIn",
                    "type": "bool"
                },
                {
                    "components": [
                        {
                            "internalType": "bytes32",
                            "name": "r",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "s",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "vAndTimeout",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.Signature[]",
                    "name": "signatures",
                    "type": "tuple[]"
                }
            ],
            "name": "offerer_multi_refundWithAuth",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                }
            ],
            "name": "offerer_refund",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "components": [
                        {
                            "internalType": "address",
                            "name": "offerer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "claimer",
                            "type": "address"
                        },
                        {
                            "internalType": "address",
                            "name": "token",
                            "type": "address"
                        },
                        {
                            "internalType": "uint256",
                            "name": "amount",
                            "type": "uint256"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "paymentHash",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "data",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.AtomicSwapStruct",
                    "name": "payReq",
                    "type": "tuple"
                },
                {
                    "components": [
                        {
                            "internalType": "bytes32",
                            "name": "r",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "bytes32",
                            "name": "s",
                            "type": "bytes32"
                        },
                        {
                            "internalType": "uint256",
                            "name": "vAndTimeout",
                            "type": "uint256"
                        }
                    ],
                    "internalType": "struct CrossLightningSwaps.Signature",
                    "name": "signature",
                    "type": "tuple"
                }
            ],
            "name": "offerer_refundWithAuth",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "address",
                    "name": "",
                    "type": "address"
                },
                {
                    "internalType": "address",
                    "name": "",
                    "type": "address"
                },
                {
                    "internalType": "uint256",
                    "name": "",
                    "type": "uint256"
                }
            ],
            "name": "reputation",
            "outputs": [
                {
                    "internalType": "uint256",
                    "name": "success",
                    "type": "uint256"
                },
                {
                    "internalType": "uint256",
                    "name": "coopClose",
                    "type": "uint256"
                },
                {
                    "internalType": "uint256",
                    "name": "failed",
                    "type": "uint256"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {
                    "internalType": "address",
                    "name": "token",
                    "type": "address"
                },
                {
                    "internalType": "uint256",
                    "name": "amount",
                    "type": "uint256"
                }
            ],
            "name": "withdraw",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        }
    ]
};