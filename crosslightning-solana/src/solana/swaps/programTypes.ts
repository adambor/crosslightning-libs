export type SwapProgram = {
    "version": "0.1.0",
    "name": "swap_program",
    "instructions": [
        {
            "name": "deposit",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "signerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
                ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "withdraw",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "signerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
                ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "offererInitializePayIn",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": true
                },
                {
                    "name": "offererAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "claimerAta",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "swapData",
                    "type": {
                        "defined": "SwapData"
                    }
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    }
                },
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "offererInitialize",
            "accounts": [
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": true
                },
                {
                    "name": "offererUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "claimerAta",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "swapData",
                    "type": {
                        "defined": "SwapData"
                    }
                },
                {
                    "name": "securityDeposit",
                    "type": "u64"
                },
                {
                    "name": "claimerBounty",
                    "type": "u64"
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    }
                },
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "offererRefund",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "offererUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "offererRefundPayIn",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "offererAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
                ]
        },
        {
            "name": "claimerClaim",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
                ]
        },
        {
            "name": "claimerClaimPayOut",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                }
                ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
                ]
        },
        {
            "name": "initData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": true
                }
                ],
            "args": []
        },
        {
            "name": "writeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                }
                ],
            "args": [
                {
                    "name": "start",
                    "type": "u32"
                },
                {
                    "name": "data",
                    "type": "bytes"
                }
                ]
        },
        {
            "name": "closeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                }
                ],
            "args": []
        }
        ],
    "accounts": [
        {
            "name": "escrowState",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "data",
                        "type": {
                            "defined": "SwapData"
                        }
                    },
                    {
                        "name": "offerer",
                        "type": "publicKey"
                    },
                    {
                        "name": "offererAta",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimer",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimerAta",
                        "type": "publicKey"
                    },
                    {
                        "name": "mint",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimerBounty",
                        "type": "u64"
                    },
                    {
                        "name": "securityDeposit",
                        "type": "u64"
                    }
                    ]
            }
        },
        {
            "name": "userAccount",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "successVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "successCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "failVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "failCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "coopCloseVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "coopCloseCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                                ]
                        }
                    },
                    {
                        "name": "bump",
                        "type": "u8"
                    }
                    ]
            }
        }
        ],
    "types": [
        {
            "name": "SwapData",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "kind",
                        "type": {
                            "defined": "SwapType"
                        }
                    },
                    {
                        "name": "confirmations",
                        "type": "u16"
                    },
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "hash",
                        "type": {
                            "array": [
                                "u8",
                                32
                                ]
                        }
                    },
                    {
                        "name": "payIn",
                        "type": "bool"
                    },
                    {
                        "name": "payOut",
                        "type": "bool"
                    },
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "expiry",
                        "type": "u64"
                    },
                    {
                        "name": "sequence",
                        "type": "u64"
                    }
                    ]
            }
        },
        {
            "name": "SwapType",
            "type": {
                "kind": "enum",
                "variants": [
                    {
                        "name": "Htlc"
                    },
                    {
                        "name": "Chain"
                    },
                    {
                        "name": "ChainNonced"
                    },
                    {
                        "name": "ChainTxhash"
                    }
                    ]
            }
        }
        ],
    "events": [
        {
            "name": "InitializeEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    },
                    "index": false
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    },
                    "index": false
                },
                {
                    "name": "nonce",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "kind",
                    "type": {
                        "defined": "SwapType"
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
                ]
        },
        {
            "name": "RefundEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
                ]
        },
        {
            "name": "ClaimEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    },
                    "index": false
                },
                {
                    "name": "secret",
                    "type": {
                        "array": [
                            "u8",
                            32
                            ]
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
                ]
        }
        ],
    "errors": [
        {
            "code": 6000,
            "name": "AuthExpired",
            "msg": "Authorization expired."
        },
        {
            "code": 6001,
            "name": "NotExpiredYet",
            "msg": "Request not expired yet."
        },
        {
            "code": 6002,
            "name": "AlreadyExpired",
            "msg": "Request already expired."
        },
        {
            "code": 6003,
            "name": "InvalidSecret",
            "msg": "Invalid secret provided."
        },
        {
            "code": 6004,
            "name": "InsufficientFunds",
            "msg": "Not enough funds."
        },
        {
            "code": 6005,
            "name": "KindUnknown",
            "msg": "Unknown type of the contract."
        },
        {
            "code": 6006,
            "name": "TooManyConfirmations",
            "msg": "Too many confirmations required."
        },
        {
            "code": 6007,
            "name": "InvalidTxVerifyProgramId",
            "msg": "Invalid program id for transaction verification."
        },
        {
            "code": 6008,
            "name": "InvalidTxVerifyIx",
            "msg": "Invalid instruction for transaction verification."
        },
        {
            "code": 6009,
            "name": "InvalidTxVerifyTxid",
            "msg": "Invalid txid for transaction verification."
        },
        {
            "code": 6010,
            "name": "InvalidTxVerifyConfirmations",
            "msg": "Invalid confirmations for transaction verification."
        },
        {
            "code": 6011,
            "name": "InvalidTx",
            "msg": "Invalid transaction/nSequence"
        },
        {
            "code": 6012,
            "name": "InvalidNonce",
            "msg": "Invalid nonce used"
        },
        {
            "code": 6013,
            "name": "InvalidVout",
            "msg": "Invalid vout of the output used"
        },
        {
            "code": 6014,
            "name": "InvalidAccountWritability",
            "msg": "Account cannot be written to"
        },
        {
            "code": 6015,
            "name": "InvalidDataAccount",
            "msg": "Invalid data account"
        },
        {
            "code": 6016,
            "name": "InvalidUserData",
            "msg": "Invalid user data account"
        },
        {
            "code": 6017,
            "name": "InvalidBlockheightVerifyProgramId",
            "msg": "Invalid program id for blockheight verification."
        },
        {
            "code": 6018,
            "name": "InvalidBlockheightVerifyIx",
            "msg": "Invalid instruction for blockheight verification."
        },
        {
            "code": 6019,
            "name": "InvalidBlockheightVerifyHeight",
            "msg": "Invalid height for blockheight verification."
        },
        {
            "code": 6020,
            "name": "InvalidBlockheightVerifyOperation",
            "msg": "Invalid operation for blockheight verification."
        },
        {
            "code": 6021,
            "name": "SignatureVerificationFailedInvalidProgram",
            "msg": "Signature verification failed: invalid ed25519 program id"
        },
        {
            "code": 6022,
            "name": "SignatureVerificationFailedAccountsLength",
            "msg": "Signature verification failed: invalid accounts length"
        },
        {
            "code": 6023,
            "name": "SignatureVerificationFailedDataLength",
            "msg": "Signature verification failed: invalid data length"
        },
        {
            "code": 6024,
            "name": "SignatureVerificationFailedInvalidHeader",
            "msg": "Signature verification failed: invalid header"
        },
        {
            "code": 6025,
            "name": "SignatureVerificationFailedInvalidData",
            "msg": "Signature verification failed: invalid data"
        },
        {
            "code": 6026,
            "name": "InvalidSwapDataPayIn",
            "msg": "Invalid swap data: pay in"
        },
        {
            "code": 6027,
            "name": "InvalidSwapDataNonce",
            "msg": "Invalid swap data: nonce"
        }
        ]
};

export const IDL: SwapProgram = {
    "version": "0.1.0",
    "name": "swap_program",
    "instructions": [
        {
            "name": "deposit",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "signerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "withdraw",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "signerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "offererInitializePayIn",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": true
                },
                {
                    "name": "offererAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "claimerAta",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "swapData",
                    "type": {
                        "defined": "SwapData"
                    }
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "offererInitialize",
            "accounts": [
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": true
                },
                {
                    "name": "offererUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "claimerAta",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "swapData",
                    "type": {
                        "defined": "SwapData"
                    }
                },
                {
                    "name": "securityDeposit",
                    "type": "u64"
                },
                {
                    "name": "claimerBounty",
                    "type": "u64"
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "offererRefund",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "offererUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "offererRefundPayIn",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "claimer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "offererAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "claimerClaim",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerUserData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "claimerClaimPayOut",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerAta",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                }
            ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "initData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": true
                }
            ],
            "args": []
        },
        {
            "name": "writeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "start",
                    "type": "u32"
                },
                {
                    "name": "data",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "closeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": []
        }
    ],
    "accounts": [
        {
            "name": "escrowState",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "data",
                        "type": {
                            "defined": "SwapData"
                        }
                    },
                    {
                        "name": "offerer",
                        "type": "publicKey"
                    },
                    {
                        "name": "offererAta",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimer",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimerAta",
                        "type": "publicKey"
                    },
                    {
                        "name": "mint",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimerBounty",
                        "type": "u64"
                    },
                    {
                        "name": "securityDeposit",
                        "type": "u64"
                    }
                ]
            }
        },
        {
            "name": "userAccount",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "successVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "successCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "failVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "failCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "coopCloseVolume",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "coopCloseCount",
                        "type": {
                            "array": [
                                "u64",
                                4
                            ]
                        }
                    },
                    {
                        "name": "bump",
                        "type": "u8"
                    }
                ]
            }
        }
    ],
    "types": [
        {
            "name": "SwapData",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "kind",
                        "type": {
                            "defined": "SwapType"
                        }
                    },
                    {
                        "name": "confirmations",
                        "type": "u16"
                    },
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "hash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "payIn",
                        "type": "bool"
                    },
                    {
                        "name": "payOut",
                        "type": "bool"
                    },
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "expiry",
                        "type": "u64"
                    },
                    {
                        "name": "sequence",
                        "type": "u64"
                    }
                ]
            }
        },
        {
            "name": "SwapType",
            "type": {
                "kind": "enum",
                "variants": [
                    {
                        "name": "Htlc"
                    },
                    {
                        "name": "Chain"
                    },
                    {
                        "name": "ChainNonced"
                    },
                    {
                        "name": "ChainTxhash"
                    }
                ]
            }
        }
    ],
    "events": [
        {
            "name": "InitializeEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "nonce",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "kind",
                    "type": {
                        "defined": "SwapType"
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
            ]
        },
        {
            "name": "RefundEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
            ]
        },
        {
            "name": "ClaimEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "secret",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "sequence",
                    "type": "u64",
                    "index": false
                }
            ]
        }
    ],
    "errors": [
        {
            "code": 6000,
            "name": "AuthExpired",
            "msg": "Authorization expired."
        },
        {
            "code": 6001,
            "name": "NotExpiredYet",
            "msg": "Request not expired yet."
        },
        {
            "code": 6002,
            "name": "AlreadyExpired",
            "msg": "Request already expired."
        },
        {
            "code": 6003,
            "name": "InvalidSecret",
            "msg": "Invalid secret provided."
        },
        {
            "code": 6004,
            "name": "InsufficientFunds",
            "msg": "Not enough funds."
        },
        {
            "code": 6005,
            "name": "KindUnknown",
            "msg": "Unknown type of the contract."
        },
        {
            "code": 6006,
            "name": "TooManyConfirmations",
            "msg": "Too many confirmations required."
        },
        {
            "code": 6007,
            "name": "InvalidTxVerifyProgramId",
            "msg": "Invalid program id for transaction verification."
        },
        {
            "code": 6008,
            "name": "InvalidTxVerifyIx",
            "msg": "Invalid instruction for transaction verification."
        },
        {
            "code": 6009,
            "name": "InvalidTxVerifyTxid",
            "msg": "Invalid txid for transaction verification."
        },
        {
            "code": 6010,
            "name": "InvalidTxVerifyConfirmations",
            "msg": "Invalid confirmations for transaction verification."
        },
        {
            "code": 6011,
            "name": "InvalidTx",
            "msg": "Invalid transaction/nSequence"
        },
        {
            "code": 6012,
            "name": "InvalidNonce",
            "msg": "Invalid nonce used"
        },
        {
            "code": 6013,
            "name": "InvalidVout",
            "msg": "Invalid vout of the output used"
        },
        {
            "code": 6014,
            "name": "InvalidAccountWritability",
            "msg": "Account cannot be written to"
        },
        {
            "code": 6015,
            "name": "InvalidDataAccount",
            "msg": "Invalid data account"
        },
        {
            "code": 6016,
            "name": "InvalidUserData",
            "msg": "Invalid user data account"
        },
        {
            "code": 6017,
            "name": "InvalidBlockheightVerifyProgramId",
            "msg": "Invalid program id for blockheight verification."
        },
        {
            "code": 6018,
            "name": "InvalidBlockheightVerifyIx",
            "msg": "Invalid instruction for blockheight verification."
        },
        {
            "code": 6019,
            "name": "InvalidBlockheightVerifyHeight",
            "msg": "Invalid height for blockheight verification."
        },
        {
            "code": 6020,
            "name": "InvalidBlockheightVerifyOperation",
            "msg": "Invalid operation for blockheight verification."
        },
        {
            "code": 6021,
            "name": "SignatureVerificationFailedInvalidProgram",
            "msg": "Signature verification failed: invalid ed25519 program id"
        },
        {
            "code": 6022,
            "name": "SignatureVerificationFailedAccountsLength",
            "msg": "Signature verification failed: invalid accounts length"
        },
        {
            "code": 6023,
            "name": "SignatureVerificationFailedDataLength",
            "msg": "Signature verification failed: invalid data length"
        },
        {
            "code": 6024,
            "name": "SignatureVerificationFailedInvalidHeader",
            "msg": "Signature verification failed: invalid header"
        },
        {
            "code": 6025,
            "name": "SignatureVerificationFailedInvalidData",
            "msg": "Signature verification failed: invalid data"
        },
        {
            "code": 6026,
            "name": "InvalidSwapDataPayIn",
            "msg": "Invalid swap data: pay in"
        },
        {
            "code": 6027,
            "name": "InvalidSwapDataNonce",
            "msg": "Invalid swap data: nonce"
        }
    ]
};
