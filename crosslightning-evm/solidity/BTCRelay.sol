pragma solidity ^0.8.7;

/// @title BTCRelay implementation in Solidity
/// @notice Stores Bitcoin block _headers and heaviest (PoW) chain tip, and allows verification of transaction inclusion proofs 
contract BTCRelay {
    
    struct Header {
        uint32 version;
        bytes32 reversedPrevBlockHash;
        bytes32 merkleRoot;
        uint32 timestamp;
        uint32 nbits;
        uint32 nonce;
    }

    // Data structure representing a Bitcoin block header
    struct HeaderInfo {
        uint256 chainWork; // accumulated PoW at this height
        
        bytes32 reversedPrevBlockHash; //Not sure if this one is really necessary
        bytes32 merkleRoot;

        //Timestamps and blockHeight are BE, others are LE
        uint256 data1; //version, nbits, nonce, lastDiffAdjustement, blockHeight, prevTs0, prevTs1, prevTs2
        uint256 data2; //prevTs3, prevTs4, prevTs5, prevTs6, prevTs7, prevTs8, prevTs9, timestamp

        /*uint32 version;
        uint32 timestamp;
        uint32 nbits;
        uint32 nonce;

        uint32 lastDiffAdjustment; // necessary to track, should a fork include a diff. adjustment block
        uint32 blockHeight; // height of this block header

        uint32[10] prevBlockTimestamps;*/
    }

    // Temporary data structure used for fork submissions. 
    // Will be deleted upon success. Reasing in case of failure has no benefit to caller(!)
    struct Fork {
        uint256 startHeight; // start height of a fork
        //uint32 length; // number of block in fork
        //uint256 chainWork; // accumulated PoW on the fork branch
        bytes32[] forkHeaderHashes; // references to submitted block headers
    }

    mapping(uint256 => bytes32) public _mainChain; // mapping of block heights to commitment hashes of the MAIN CHAIN

    //uint32 public _blockHeight; // block height of the main chain
    uint32 public _startHeight;
    uint32 public _lastDiffAdjustmentTime; // timestamp of the block of last difficulty adjustment (blockHeight % 2016 == 0)
    uint256 public _highScoreAndBlockHeight; // highest chainWork, i.e., accumulated PoW at current blockchain tip    
    mapping(uint256 => Fork) public _ongoingForks; // mapping of currently onoing fork submissions
    uint256 public _forkCounter = 1; // incremental counter for tracking fork submission. 0 used to indicate a main chain submission
    
    // CONSTANTS
    /*
    * Bitcoin difficulty constants
    */ 
    uint256 public constant PRUNING_FACTOR = 250; //Only keep last n blocks
    uint256 public constant DIFFICULTY_ADJUSTMENT_INVETVAL = 2016;
    uint256 public constant TARGET_TIMESPAN = 14 * 24 * 60 * 60; // 2 weeks 
    uint256 public constant UNROUNDED_MAX_TARGET = 2**224 - 1; 
    uint256 public constant TARGET_TIMESPAN_DIV_4 = TARGET_TIMESPAN / 4; // store division as constant to save costs
    uint256 public constant TARGET_TIMESPAN_MUL_4 = TARGET_TIMESPAN * 4; // store multiplucation as constant to save costs
    
    uint256 public constant MAX_FUTURE_BLOCKTIME = 4 * 60 * 60; //4 hours

    // EVENTS
    /*
    * @param blockHash block header hash of block header submitted for storage
    * @param blockHeight blockHeight
    */
    //event StoreHeader(bytes32 indexed blockHash, uint256 indexed blockHeight);
    event StoreHeader(bytes32 indexed commitmentHash, bytes32 indexed blockHash, HeaderInfo storedHeader);
    //event StoreHeader(bytes32 indexed commitmentHash, bytes32 indexed blockHash, uint256 blockHeight, HeaderInfo storedHeader);
    /*
    * @param blockHash block header hash of block header submitted for storage
    * @param blockHeight blockHeight
    * @param forkId identifier of fork in the contract
    */
    //event StoreFork(bytes32 indexed blockHash, uint256 indexed blockHeight, uint256 indexed forkId);
    event StoreFork(bytes32 indexed commitmentHash, bytes32 indexed blockHash, uint256 indexed forkId, HeaderInfo storedHeader);
    /*
    * @param newChainTip new tip of the blockchain after a triggered chain reorg. 
    * @param startHeight start blockHeight of fork
    * @param forkId identifier of the fork triggering the reorg.
    */
    event ChainReorg(bytes32 indexed newChainTip, uint256 indexed startHeight, uint256 indexed forkId);


    // EXCEPTION MESSAGES
    string ERR_GENESIS_SET = "Initial parent has already been set";
    string ERR_INVALID_FORK_ID = "Incorrect fork identifier: id 0 is no available";
    string ERR_INVALID_HEADER_SIZE = "Invalid block header size";
    string ERR_DUPLICATE_BLOCK = "Block already stored";
    string ERR_PREV_BLOCK = "Previous block hash not found"; 
    string ERR_LOW_DIFF = "PoW hash does not meet difficulty target of header";
    string ERR_DIFF_TARGET_HEADER = "Incorrect difficulty target specified in block header";
    string ERR_NOT_MAIN_CHAIN = "Main chain submission indicated, but submitted block is on a fork";
    string ERR_FORK_PREV_BLOCK = "Previous block hash does not match last block in fork submission";
    string ERR_NOT_FORK = "Indicated fork submission, but block is in main chain";
    string ERR_INVALID_TXID = "Invalid transaction identifier";
    string ERR_CONFIRMS = "Transaction has less confirmations than requested"; 
    string ERR_MERKLE_PROOF = "Invalid Merkle Proof structure";
    
    /*
    * @notice Initialized BTCRelay with provided block, i.e., defined the first block of the stored chain. 
    * @dev TODO: check issue with "blockHeight mod 2016 = 2015" requirement (old btc relay!). Alexei: IMHO should be called with "blockHeight mod 2016 = 0"
    * @param blockHeaderBytes Raw Bitcoin block headers
    * @param blockHeight block blockHeight
    * @param chainWork total accumulated PoW at given block blockHeight/hash 
    * @param lastDiffAdjustmentTime timestamp of the block of the last diff. adjustment. Note: diff. target of that block MUST be equal to @param target 
    */
    function setInitialParent(
        Header calldata blockHeader, 
        uint256 blockHeight, 
        uint256 chainWork,
        uint32 lastDiffAdjustmentTime,
        uint256[10] calldata prevBlockTimestamps) 
        public {
            
        require(_highScoreAndBlockHeight == 0, ERR_GENESIS_SET);
        
        bytes32 blockHeaderHash = dblSha(blockHeader);
        _highScoreAndBlockHeight = uint256(blockHeight)<<224 | (chainWork & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        _lastDiffAdjustmentTime = lastDiffAdjustmentTime;

        uint256 data1 = uint256(blockHeader.version)<<224 |
            uint256(blockHeader.nbits)<<192 |
            uint256(blockHeader.nonce)<<160 |
            uint256(lastDiffAdjustmentTime)<<128 |
            uint256(blockHeight)<<96 |
            uint256(prevBlockTimestamps[0])<<64 |
            uint256(prevBlockTimestamps[1])<<32 |
            uint256(prevBlockTimestamps[2]);

        uint256 data2 = uint256(prevBlockTimestamps[3])<<224 |
            uint256(prevBlockTimestamps[4])<<192 |
            uint256(prevBlockTimestamps[5])<<160 |
            uint256(prevBlockTimestamps[6])<<128 |
            uint256(prevBlockTimestamps[7])<<96 |
            uint256(prevBlockTimestamps[8])<<64 |
            uint256(prevBlockTimestamps[9])<<32 |
            uint256(reverseUint32(blockHeader.timestamp));

        HeaderInfo memory storedHeader = HeaderInfo(
            chainWork, 
            blockHeader.reversedPrevBlockHash, 
            blockHeader.merkleRoot,
            data1,
            data2
        );

        //_mainChain[blockHeight] = blockHeaderHash;

        //emit StoreHeader(storeBlockHeader(blockHeight, 0,storedHeader), blockHeaderHash, blockHeight, storedHeader);
        bytes32 keccak256thisBlockHeader = storeBlockHeader(blockHeight, 0, storedHeader);
        assembly {
            log3(storedHeader, 160, 0x9fc4fb2e64c90ee101e27a74385448b64fa038e3075908ea993a337abecfb242, keccak256thisBlockHeader, blockHeaderHash)
        }
    }

    /*
    * @notice Submit block header to current main chain in relay
    * @dev Will revert if fork is submitted! Use submitNewForkChainHeader for fork submissions.
    */
    function submitMainChainHeaders(bytes calldata blockHeaderBytes, HeaderInfo calldata prevBlockHeader) public {
        submitBlockHeaders(blockHeaderBytes, 0, prevBlockHeader);
    }

    /*
    * @notice Submit block header to start a NEW FORK
    * @dev Increments _forkCounter and uses this as forkId
    */
    function submitNewForkChainHeaders(bytes calldata blockHeaderBytes, HeaderInfo calldata prevBlockHeader) public returns (uint256 forkCounter){
        forkCounter = _forkCounter;
        submitBlockHeaders(blockHeaderBytes, forkCounter, prevBlockHeader);
        _forkCounter = forkCounter++;
    }
    
    /*
    * @notice Submit block header to existing fork
    * @dev Will revert if previos block is not in the specified fork!
    */
    function submitForkChainHeaders(bytes calldata blockHeaderBytes, uint256 forkId, HeaderInfo calldata prevBlockHeader) public {
        require(forkId > 0, ERR_INVALID_FORK_ID);
        submitBlockHeaders(blockHeaderBytes, forkId, prevBlockHeader);   
    }
    /*
    * @notice Parses, validates and stores Bitcoin block header to mapping
    * @dev Can only be called interlally - use submitXXXHeader for public access 
    * @param blockHeaderBytes Raw Bitcoin block header bytes (80 bytes)
    * @param forkId when submitting a fork, pass forkId to reference existing fork submission (Problem: submitting to fork even if not in fork?)
    * 
    */  
    function submitBlockHeaders(bytes calldata blockHeader, uint256 forkId, HeaderInfo memory storedHeader) private {

        bytes32 lastBlockHash = dblSha_memory(storedHeader);
        uint256 blockHeight;
        uint256 highScore;
        {
            uint256 highScoreAndBlockHeight = _highScoreAndBlockHeight;
            blockHeight = highScoreAndBlockHeight>>224;
            highScore = highScoreAndBlockHeight & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        }
        uint256 lastDiffAdjustmentTime;

        uint256 startHeight = _startHeight;

        {
            bytes32 keccak256prevBlockHeader;
            assembly {
                keccak256prevBlockHeader := keccak256(storedHeader, 160)
            }
            if(forkId==0) {
                require(getCommitment(blockHeight, blockHeight, startHeight)==keccak256prevBlockHeader, "Invalid prev block commitment");
            } else {
                uint256 maxHeight = blockHeight;
                blockHeight = (storedHeader.data1>>96) & 0xFFFFFFFF;
                if(_ongoingForks[forkId].forkHeaderHashes.length != 0) {
                    //Existing fork
                    require(getLatestForkHash(forkId) == keccak256prevBlockHeader, ERR_FORK_PREV_BLOCK);
                } else {
                    //New fork
                    // Check that block is indeed a fork
                    require(getCommitment(blockHeight, maxHeight, startHeight)==keccak256prevBlockHeader, "Invalid prev block commitment");
                }
            }
        }

        uint i;
        uint end;
        assembly {
            i := blockHeader.offset
            end := add(i, blockHeader.length)
        }

        for(;i<end; i+=80) {

            ++blockHeight;

            {
                //Prev block hash matches
                bytes32 hashPrevBlock;
                {
                    assembly {
                        hashPrevBlock := calldataload(add(i, 4))
                    }
                    require(hashPrevBlock==lastBlockHash, "Invalid prev block");
                }

                uint256 data1 = storedHeader.data1;

                uint256 nbits;
                uint256 ts;
                assembly {
                    let val := calldataload(add(i, 44))
                    ts := and(shr(32, val), 0xFFFFFFFF)
                    nbits := and(val, 0xFFFFFFFF)
                    pop(val)
                }
                ts = reverseUint32(ts);
                // Check the specified difficulty target is correct:
                // If retarget: according to Bitcoin's difficulty adjustment mechanism;
                // Else: same as last block. 
                if(correctDifficultyTarget(storedHeader, blockHeight, nbits)) {
                    //This block
                    lastDiffAdjustmentTime = ts;
                } else {
                    //Same as last block
                    lastDiffAdjustmentTime = (data1>>128) & 0xFFFFFFFF;
                }
                
                {
                    bytes32 hashCurrentBlock = dblSha(i);
                    uint256 target = getTargetFromHeader(nbits);
                    require(reverse(hashCurrentBlock) <= bytes32(target), ERR_LOW_DIFF);
                    storedHeader.chainWork += getDifficulty(target);
                    lastBlockHash = hashCurrentBlock;
                }
                
                uint256 data2 = storedHeader.data2;

                require(largerThanMedian(data1, data2, ts), "Block timestamp too low");
                require(ts<block.timestamp+MAX_FUTURE_BLOCKTIME, "Block timestamp too high");

                data1 = ((data1<<32) & 0x0000000000000000000000000000000000000000FFFFFFFFFFFFFFFF00000000) |
                    ((data2>>224) & 0xFFFFFFFF);

                //data1 |= uint256(blockHeader[i].version)<<224 |
                //    uint256(blockHeader[i].nonce)<<160;
                assembly {
                    data1 := or(
                        data1,
                        or(
                            and(calldataload(i), 0xFFFFFFFF00000000000000000000000000000000000000000000000000000000),
                            and(calldataload(add(i, 68)), 0x0000000000000000FFFFFFFF0000000000000000000000000000000000000000)
                        )
                    )
                }

                data1 |= uint256(nbits)<<192 |
                    uint256(lastDiffAdjustmentTime)<<128 | 
                    uint256(blockHeight)<<96;

                storedHeader.data1 = data1;
                storedHeader.data2 = data2<<32 | uint256(ts);
                storedHeader.reversedPrevBlockHash = hashPrevBlock;
                //storedHeader.merkleRoot = blockHeader[i].merkleRoot;
                assembly {
                    calldatacopy(add(storedHeader, 64), add(i, 36), 32)
                }
            }

            bytes32 keccak256thisBlockHeader;
            assembly {
                keccak256thisBlockHeader := keccak256(storedHeader, 160)
            }

            // Fork handling
            if(forkId == 0){
                // Main chain submission
                if(i==0) {
                    require(storedHeader.chainWork > highScore, ERR_NOT_MAIN_CHAIN);
                }
                startHeight = storeBlockCommitment(blockHeight, startHeight, keccak256thisBlockHeader);
                //emit StoreHeader(keccak256thisBlockHeader, lastBlockHash, storedHeader);
                assembly {
                    log3(storedHeader, 160, 0x9fc4fb2e64c90ee101e27a74385448b64fa038e3075908ea993a337abecfb242, keccak256thisBlockHeader, lastBlockHash)
                }
            } else {
                if(_ongoingForks[forkId].forkHeaderHashes.length != 0) {
                    // Submission to ongoing fork
                    // check that prev. block hash of current block is indeed in the fork
                    if(storedHeader.chainWork > highScore){
                        startHeight = executeForkAndRemove(forkId, startHeight);
                        startHeight = storeBlockCommitment(blockHeight, startHeight, keccak256thisBlockHeader);
                        //emit StoreHeader(keccak256thisBlockHeader, lastBlockHash, storedHeader);
                        assembly {
                            log3(storedHeader, 160, 0x9fc4fb2e64c90ee101e27a74385448b64fa038e3075908ea993a337abecfb242, keccak256thisBlockHeader, lastBlockHash)
                        }
                        forkId = 0; //Set fork ID to 0 so next blocks will be appended to main chain
                        continue;
                    }
                } else {
                    // Submission of new fork
                    assert(forkId == _forkCounter);
                    
                    require(getCommitment(blockHeight) != keccak256thisBlockHeader, ERR_NOT_FORK);

                    _ongoingForks[forkId].startHeight = blockHeight;
                }
                storeForkCommitment(forkId, keccak256thisBlockHeader);
                //emit StoreFork(keccak256thisBlockHeader, lastBlockHash, forkId, storedHeader);
                assembly {
                    log4(storedHeader, 160, 0x2d8d54f6e05054b3febd04b2067c23c239093d4bb4e053a474ea38e46e79c283, keccak256thisBlockHeader, lastBlockHash, forkId)
                }
            }
        }
        
        if(forkId==0) {
            //_heaviestBlock = lastBlockHash;
            //_highScore = storedHeader.chainWork;
            //_blockHeight = storedHeader.blockHeight;
            _highScoreAndBlockHeight = uint256(blockHeight)<<224 | (storedHeader.chainWork & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
            if(uint32(lastDiffAdjustmentTime)!=_lastDiffAdjustmentTime) _lastDiffAdjustmentTime = uint32(lastDiffAdjustmentTime);
        }
        
    }

    function executeForkAndRemove(uint256 forkId, uint256 startHeight) private returns (uint256) {
        uint256 forkStartHeight = _ongoingForks[forkId].startHeight;
        uint256 currentHeight = forkStartHeight;
        uint256 forkLen = _ongoingForks[forkId].forkHeaderHashes.length;
        for (uint e = 0; e < forkLen; e++) {                    
            // Delete old block header data. 
            // Note: This refunds gas!
            // TODO: optimze such that users do not get cut-off by tx.gasUsed / 2
            //delete _headers[_mainChain[currentHeight]];
            // Update main chain height pointer to new header from fork
            startHeight = storeBlockCommitment(currentHeight, startHeight, _ongoingForks[forkId].forkHeaderHashes[e]);
            //_mainChain[currentHeight] = _ongoingForks[forkId].forkHeaderHashes[e];
            currentHeight++;
        }
        emit ChainReorg(getCommitment(currentHeight-1), forkStartHeight, forkId);

        // Delete successful fork submission
        // This refunds gas!
        delete _ongoingForks[forkId];
        //delete fork;

        return startHeight;
    }

    function getPosition(uint256 blockHeight) private view returns (uint256) {
        uint256 startHeight = _startHeight;
        return getPosition(blockHeight, startHeight);
    }

    function getCommitment(uint256 blockHeight) public view returns (bytes32) {
        uint256 maxHeight = getBlockHeight();
        if(blockHeight>maxHeight) return bytes32(0x00);
        if(blockHeight<=maxHeight-PRUNING_FACTOR) return bytes32(0x00);
        return _mainChain[getPosition(blockHeight)];
    }

    function getPosition(uint256 blockHeight, uint256 startHeight) private pure returns (uint256) {
        if(startHeight<=blockHeight) {
            uint256 pos = blockHeight-startHeight;
            if(pos>=PRUNING_FACTOR) return 0;
            return pos;
        } else {
            uint256 pos = startHeight-blockHeight;
            if(pos>=PRUNING_FACTOR) return 0;
            return pos;
        }
    }

    function getCommitment(uint256 blockHeight, uint256 maxHeight, uint256 startHeight) private view returns (bytes32) {
        if(blockHeight>maxHeight) return bytes32(0x00);
        if(blockHeight<=maxHeight-PRUNING_FACTOR) return bytes32(0x00);
        return _mainChain[getPosition(blockHeight, startHeight)];
    }

    function storeBlockCommitment(uint256 blockHeight, uint256 startHeight, bytes32 commitmentHash) private returns (uint256) {
        uint256 pos = getPosition(blockHeight, startHeight);
        _mainChain[pos] = commitmentHash;
        if(pos==0) {
            _startHeight = uint32(blockHeight);
            startHeight = blockHeight;
        }
        return startHeight;
    }

    function storeBlockHeader(uint256 blockHeight, uint256 startHeight, HeaderInfo memory storedHeader) private returns (bytes32 commitmentHash) {
        assembly {
            commitmentHash := keccak256(storedHeader, 160)
        }

        storeBlockCommitment(blockHeight, startHeight, commitmentHash);
    }

    function storeForkCommitment(uint256 forkId, bytes32 commitmentHash) private {
        _ongoingForks[forkId].forkHeaderHashes.push(commitmentHash);
    }

    /*
    * @notice Verifies that a transaction is included in a block at a given blockheight
    * @param txid transaction identifier
    * @param txBlockHeight block height at which transacton is supposedly included
    * @param txIndex index of transaction in the block's tx merkle tree
    * @param merkleProof  merkle tree path (concatenated LE sha256 hashes)
    * @return True if txid is at the claimed position in the block at the given blockheight, False otherwise
    */
    function verifyTX(bytes32 reversedTxid, uint256 txBlockHeight, uint256 txIndex, bytes calldata merkleProof, uint256 confirmations, HeaderInfo memory blockHeader) public view returns(bool) {
        // txid must not be 0
        require(reversedTxid != bytes32(0x0), ERR_INVALID_TXID);
        
        uint256 blockHeight = getBlockHeight();
        uint256 startHeight = _startHeight;

        // check requrested confirmations. No need to compute proof if insufficient confs.
        require(blockHeight - txBlockHeight + 1 >= confirmations, ERR_CONFIRMS);

        //bytes32 blockHeaderHash = _mainChain[txBlockHeight];
        bytes32 commitmentHash;
        assembly {
            commitmentHash := keccak256(blockHeader, 160)
        }

        require(getCommitment(txBlockHeight, blockHeight, startHeight)==commitmentHash, "Invalid block header supplied");
        //bytes32 merkleRoot =_headers[blockHeaderHash].merkleRoot;
        
        // compute merkle tree root and check if it matches block's original merkle tree root
        if(computeMerkle_calldata(reversedTxid, txIndex, merkleProof) == blockHeader.merkleRoot){
            return true;
        }
        return false;
    }

    /*function dblShaReverse(Header calldata data) public view returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            let memPtr := mload(0x40)

            calldatacopy(memPtr, add(data,28), 4)
            calldatacopy(add(memPtr, 4), add(data,32), 32)
            calldatacopy(add(memPtr, 36), add(data,64), 32)
            calldatacopy(add(memPtr, 68), add(data,124), 4)
            calldatacopy(add(memPtr, 72), add(data,156), 4)
            calldatacopy(add(memPtr, 76), add(data,188), 4)


            pop(staticcall(gas(), 0x02, memPtr, 80, 0x00, 32))
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
            
            // swap bytes
            value := or(shr(8, and(value, 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00)), shl(8, and(value, 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)))
            value := or(shr(16, and(value, 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000)), shl(16, and(value, 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)))
            value := or(shr(32, and(value, 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000)), shl(32, and(value, 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)))
            value := or(shr(64, and(value, 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000)), shl(64, and(value, 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)))
            value := or(shr(128, value), shl(128, value))
        }
    }

    function dblShaReverse_memory(HeaderInfo memory data) public view returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            function reverseUint32(input) -> output {
                output := or(shr(8, and(input, 0xFF00FF00)), shl(8, and(input, 0x00FF00FF)))
                output := or(shr(16, and(output, 0xFFFF0000)), shl(16, and(output, 0x0000FFFF)))
            }

            let memPtr := mload(0x40)

            mstore(memPtr, mload(add(data,96))) //Version
            mstore(add(memPtr, 4), mload(add(data,32))) //Prev block hash
            mstore(add(memPtr, 36), mload(add(data,64))) //Merkle root
            mstore(add(memPtr, 68), shl(224 ,reverseUint32(mload(add(data,128))))) //Timestamp
            mstore(add(memPtr, 72), mload(add(data,100))) //nbits
            mstore(add(memPtr, 76), mload(add(data,104))) //nonce

            pop(staticcall(gas(), 0x02, memPtr, 80, 0x00, 32))
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
            
            // swap bytes
            value := or(shr(8, and(value, 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00)), shl(8, and(value, 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)))
            value := or(shr(16, and(value, 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000)), shl(16, and(value, 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)))
            value := or(shr(32, and(value, 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000)), shl(32, and(value, 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)))
            value := or(shr(64, and(value, 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000)), shl(64, and(value, 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)))
            value := or(shr(128, value), shl(128, value))
        }
    }*/

    function dblSha(Header calldata data) private view returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            let memPtr := mload(0x40)

            calldatacopy(memPtr, add(data,28), 4)
            calldatacopy(add(memPtr, 4), add(data,32), 32)
            calldatacopy(add(memPtr, 36), add(data,64), 32)
            calldatacopy(add(memPtr, 68), add(data,124), 4)
            calldatacopy(add(memPtr, 72), add(data,156), 4)
            calldatacopy(add(memPtr, 76), add(data,188), 4)


            pop(staticcall(gas(), 0x02, memPtr, 80, 0x00, 32))
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }
    }

    function dblSha(uint256 i) private view returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            let memPtr := mload(0x40)

            calldatacopy(memPtr, i, 80)

            pop(staticcall(gas(), 0x02, memPtr, 80, 0x00, 32))
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }
    }

    function dblSha_memory(HeaderInfo memory data) private view returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            function reverseUint32(input) -> output {
                output := or(shr(8, and(input, 0xFF00FF00)), shl(8, and(input, 0x00FF00FF)))
                output := or(shr(16, and(output, 0xFFFF0000)), shl(16, and(output, 0x0000FFFF)))
            }

            let memPtr := mload(0x40)

            mstore(memPtr, mload(add(data,96))) //Version
            mstore(add(memPtr, 4), mload(add(data,32))) //Prev block hash
            mstore(add(memPtr, 36), mload(add(data,64))) //Merkle root
            mstore(add(memPtr, 68), shl(224 ,reverseUint32(mload(add(data,128))))) //Timestamp
            mstore(add(memPtr, 72), mload(add(data,100))) //nbits
            mstore(add(memPtr, 76), mload(add(data,104))) //nonce

            pop(staticcall(gas(), 0x02, memPtr, 80, 0x00, 32))
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }
    }

    function reverseUint32(uint256 output) private pure returns (uint256) {
        assembly {
            // swap bytes
            output := or(shr(8, and(output, 0xFF00FF00)), shl(8, and(output, 0x00FF00FF)))
            output := or(shr(16, and(output, 0xFFFF0000)), shl(16, and(output, 0x0000FFFF)))
        }
        return output;
    }

    function reverse(bytes32 output) private pure returns (bytes32) {
        assembly {
            // swap bytes
            output := or(shr(8, and(output, 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00)), shl(8, and(output, 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)))
            output := or(shr(16, and(output, 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000)), shl(16, and(output, 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)))
            output := or(shr(32, and(output, 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000)), shl(32, and(output, 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)))
            output := or(shr(64, and(output, 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000)), shl(64, and(output, 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)))
            output := or(shr(128, output), shl(128, output))
        }
        return output;
    }

    function largerThanMedian(uint256 arr, uint256 arr2, uint256 value) private pure returns (bool result) {
        assembly {
            let amt := add(
                add(
                    add(
                        lt(shr(224, arr), value),
                        lt(and(shr(192, arr), 0xFFFFFFFF), value)
                    ),
                    add(
                        lt(and(shr(160, arr), 0xFFFFFFFF), value),
                        lt(and(shr(128, arr), 0xFFFFFFFF), value)
                    )
                ),
                add(
                    add(
                        lt(and(shr(96, arr), 0xFFFFFFFF), value),
                        add(
                            lt(and(shr(64, arr), 0xFFFFFFFF), value),
                            lt(and(shr(64,arr2), 0xFFFFFFFF), value)
                        )
                    ),
                    add(
                        add(
                            lt(and(shr(32, arr), 0xFFFFFFFF), value),
                            lt(and(arr, 0xFFFFFFFF), value)
                        ),
                        add(
                            lt(and(shr(32, arr2), 0xFFFFFFFF), value),
                            lt(and(arr2, 0xFFFFFFFF), value)
                        )
                    )
                )
            )
            result := gt(amt, 5)
        }
    }

    /*
    * @notice Calculates the PoW difficulty target from compressed nBits representation, 
    * according to https://bitcoin.org/en/developer-reference#target-nbits
    * @param nBits Compressed PoW target representation
    * @return PoW difficulty target computed from nBits
    */
    function targetTonBits(uint256 target) private pure returns (uint256 nBits) {
        assembly {
            let start := 248
            for
                { }
                and(
                    gt(start, 0),
                    iszero(
                        and(target, 
                            shl(start, 0xFF)
                        )
                    ) 
                )
                { start := sub(start, 8) }
            {}

            let nSize := add(div(start, 8), 1)
            let nCompact

            if not(gt(nSize, 3)) {
                nCompact := shl(
                    mul(
                        8,
                        sub(3,nSize)
                    ),
                    target
                )
            }

            if gt(nSize, 3) {
                nCompact := shr(
                    mul(
                        8,
                        sub(nSize,3)
                    ),
                    target
                )
            }

            nCompact := and(nCompact, 0xFFFFFFFF)

            if and(nCompact, 0x00800000) {
                nCompact := shr(8, nCompact)
                nSize := add(nSize, 1)
            }

            nCompact := or(
                or(
                    and(shl(24, nCompact), 0xFF000000),
                    and(shl(8, nCompact), 0xFF0000)
                ),
                or(
                    and(shr(8, nCompact), 0xFF00),
                    nSize
                )
            )
            
            nBits := nCompact
        }
    }

    function nBitsToTarget(uint256 nBits) private pure returns (uint256){
        bytes32 target;
        assembly {
            let nSize := and(nBits, 0xFF)
            let nWord := or(
                or(
                    and(shl(8, nBits), 0x7F0000),
                    and(shr(8, nBits), 0xFF00)
                ),
                and(shr(24, nBits), 0xFF)
            )

            if eq(gt(nSize, 3), 0) {
                target := shr(mul(8, sub(3, nSize)), nWord)
            }

            if gt(nSize, 3) {
                target := shl(mul(8, sub(nSize, 3)), nWord)
            }
        }
        return uint256(target);
    }

    /*
    * @notice Checks if the difficulty target should be adjusted at this block blockHeight
    * @param blockHeight block blockHeight to be checked
    * @return true, if block blockHeight is at difficulty adjustment interval, otherwise false
    */
    function difficultyShouldBeAdjusted(uint256 blockHeight) private pure returns (bool){
        return blockHeight % DIFFICULTY_ADJUSTMENT_INVETVAL == 0;
    }

    /*
    * @notice Verifies the currently submitted block header has the correct difficutly target, based on contract parameters
    * @dev Called from submitBlockHeader. TODO: think about emitting events in this function to identify the reason for failures
    * @param hashPrevBlock Previous block hash (necessary to retrieve previous target)
    */
    function correctDifficultyTarget(HeaderInfo memory prevBlockHeader, uint256 blockHeight, uint256 nBits) private view returns(bool) {

        uint256 prevnBits = (prevBlockHeader.data1>>192) & 0xFFFFFFFF;
        uint256 prevTarget = getTargetFromHeader(prevnBits);
        
        if(!difficultyShouldBeAdjusted(blockHeight)){
            // Difficulty not adjusted at this block blockHeight
            require(!(nBits != prevnBits && prevTarget != 0), ERR_DIFF_TARGET_HEADER);
            return false;
        } else {
            // Difficulty should be adjusted at this block blockHeight => check if adjusted correctly!
            uint256 prevTime = prevBlockHeader.data2 & 0xFFFFFFFF;
            uint256 startTime = (prevBlockHeader.data1 >> 128) & 0xFFFFFFFF;
            uint256 newnBits = computeNewnBits(prevTime, startTime, prevTarget);
            require(nBits==newnBits, ERR_DIFF_TARGET_HEADER);
            return true;
        }

        /////////////////////////////////////////
        /////// TODO: ONLY ON TESTNET ///////////
        /////////////////////////////////////////
        // return difficultyShouldBeAdjusted(blockHeight);
    }

    /*
    * @notice Verifies the currently submitted block header has the correct difficutly target, based on contract parameters
    * @dev Called from submitBlockHeader. TODO: think about emitting events in this function to identify the reason for failures
    * @param hashPrevBlock Previous block hash (necessary to retrieve previous target)
    */
    function correctDifficultyTarget(Header memory prevBlockHeader, uint256 blockHeight, uint256 nBits) private view returns(bool) {
        //Header memory prevBlockHeader = _headers[hashPrevBlock].header;
        
        uint256 prevTarget = getTargetFromHeader(prevBlockHeader.nbits);
        
        if(!difficultyShouldBeAdjusted(blockHeight)){
            // Difficulty not adjusted at this block blockHeight
            require(!(nBits != prevBlockHeader.nbits && prevTarget != 0), ERR_DIFF_TARGET_HEADER);
            return false;
        } else {
            // Difficulty should be adjusted at this block blockHeight => check if adjusted correctly!
            uint256 prevTime = reverseUint32(prevBlockHeader.timestamp);
            uint256 startTime = _lastDiffAdjustmentTime;
            uint256 newnBits = computeNewnBits(prevTime, startTime, prevTarget);
            require(nBits==newnBits, ERR_DIFF_TARGET_HEADER);
            return true;
        }

        /////////////////////////////////////////
        /////// TODO: ONLY ON TESTNET ///////////
        /////////////////////////////////////////
        //return difficultyShouldBeAdjusted(blockHeight);
    }

    /*
    * @notice Computes the new difficulty target based on the given parameters, 
    * according to: https://github.com/bitcoin/bitcoin/blob/78dae8caccd82cfbfd76557f1fb7d7557c7b5edb/src/pow.cpp 
    * @param prevTime timestamp of previous block 
    * @param startTime timestamp of last re-target
    * @param prevTarget PoW difficulty target of previous block
    */
    function computeNewnBits(uint256 prevTime, uint256 startTime, uint256 prevTarget) private pure returns(uint256){
        uint256 actualTimeSpan = prevTime - startTime;
        if(actualTimeSpan < TARGET_TIMESPAN_DIV_4){
            actualTimeSpan = TARGET_TIMESPAN_DIV_4;
        } 
        if(actualTimeSpan > TARGET_TIMESPAN_MUL_4){
            actualTimeSpan = TARGET_TIMESPAN_MUL_4;
        }

        uint256 newTarget = (actualTimeSpan * prevTarget)/TARGET_TIMESPAN;
        if(newTarget > UNROUNDED_MAX_TARGET){
            newTarget = UNROUNDED_MAX_TARGET;
        }
        return targetTonBits(newTarget);
    }

    /*function computeMerkle_memory(bytes32 reversedTxHash, uint256 txIndex, bytes memory reversedMerkleProof) private view returns(bytes32 value) {
        //  Special case: only coinbase tx in block. Root == proof
        if(reversedMerkleProof.length == 0) return reversedTxHash;

        assembly {
            let len := sub(mload(reversedMerkleProof), 32)
            //let len := mul(sub(mload(reversedMerkleProof), 1), 32)
            let dataElementLocation := add(reversedMerkleProof, 32)

            mstore(mul(and(txIndex, 0x1), 0x20), reversedTxHash)
            //pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32))
            //pop(staticcall(gas(), 0x02, 0x00, 0x20, result, 32))

            for
                { let end := add(dataElementLocation, len) }
                lt(dataElementLocation, end)
                { dataElementLocation := add(dataElementLocation, 32) }
            {
                mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))

                pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
                txIndex := shr(1, txIndex)
                pop(staticcall(gas(), 0x02, 0x00, 0x20, mul(and(txIndex, 0x1), 0x20), 32)) //goes to first position if txIndex & 1 == 1 else second position
            }

            mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))

            pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))
            
            value := mload(0x00)
        }

    }

    function computeMerkle_memory(bytes32 reversedTxHash, uint256 txIndex, bytes32[] memory reversedMerkleProof) private view returns(bytes32 value) {
        //  Special case: only coinbase tx in block. Root == proof
        if(reversedMerkleProof.length == 0) return reversedTxHash;

        assembly {
            let len := mul(sub(mload(reversedMerkleProof), 1), 32)
            //let len := mul(sub(mload(reversedMerkleProof), 1), 32)
            let dataElementLocation := add(reversedMerkleProof, 0x20)

            mstore(mul(and(txIndex, 0x1), 0x20), reversedTxHash)
            //pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32))
            //pop(staticcall(gas(), 0x02, 0x00, 0x20, result, 32))

            for
                { let end := add(dataElementLocation, len) }
                lt(dataElementLocation, end)
                { dataElementLocation := add(dataElementLocation, 32) }
            {
                mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))

                pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
                txIndex := shr(1, txIndex)
                pop(staticcall(gas(), 0x02, 0x00, 0x20, mul(and(txIndex, 0x1), 0x20), 32)) //goes to first position if txIndex & 1 == 1 else second position
            }

            mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))

            pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }

    }*/

    function computeMerkle_calldata(bytes32 reversedTxHash, uint256 txIndex, bytes calldata reversedMerkleProof) private view returns(bytes32 value) {
        //  Special case: only coinbase tx in block. Root == proof
        if(reversedMerkleProof.length == 0) return reversedTxHash;

        assembly {
            let len := sub(reversedMerkleProof.length, 32)
            //let len := mul(sub(mload(reversedMerkleProof), 1), 32)
            let dataElementLocation := reversedMerkleProof.offset

            mstore(mul(and(txIndex, 0x1), 0x20), reversedTxHash)
            //pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32))
            //pop(staticcall(gas(), 0x02, 0x00, 0x20, result, 32))

            for
                { let end := add(dataElementLocation, len) }
                lt(dataElementLocation, end)
                { dataElementLocation := add(dataElementLocation, 32) }
            {
                //mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))
                calldatacopy(mul(and(not(txIndex), 0x1), 0x20), dataElementLocation, 0x20)

                pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
                txIndex := shr(1, txIndex)
                pop(staticcall(gas(), 0x02, 0x00, 0x20, mul(and(txIndex, 0x1), 0x20), 32)) //goes to first position if txIndex & 1 == 1 else second position
            }

            //mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))
            calldatacopy(mul(and(not(txIndex), 0x1), 0x20), dataElementLocation, 0x20)

            pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }
    }

    /*function computeMerkle_calldata(bytes32 reversedTxHash, uint256 txIndex, bytes32[] calldata reversedMerkleProof) private view returns(bytes32 value) {
        //  Special case: only coinbase tx in block. Root == proof
        if(reversedMerkleProof.length == 0) return reversedTxHash;

        assembly {
            let len := mul(sub(reversedMerkleProof.length, 1), 32)
            //let len := mul(sub(mload(reversedMerkleProof), 1), 32)
            let dataElementLocation := reversedMerkleProof.offset

            mstore(mul(and(txIndex, 0x1), 0x20), reversedTxHash)
            //pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32))
            //pop(staticcall(gas(), 0x02, 0x00, 0x20, result, 32))

            for
                { let end := add(dataElementLocation, len) }
                lt(dataElementLocation, end)
                { dataElementLocation := add(dataElementLocation, 32) }
            {
                //mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))
                calldatacopy(mul(and(not(txIndex), 0x1), 0x20), dataElementLocation, 0x20)

                pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
                txIndex := shr(1, txIndex)
                pop(staticcall(gas(), 0x02, 0x00, 0x20, mul(and(txIndex, 0x1), 0x20), 32)) //goes to first position if txIndex & 1 == 1 else second position
            }

            //mstore(mul(and(not(txIndex), 0x1), 0x20), mload(dataElementLocation))
            calldatacopy(mul(and(not(txIndex), 0x1), 0x20), dataElementLocation, 0x20)

            pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 32)) //first hash
            pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 32))

            value := mload(0x00)
        }


    }*/

    function getHighScore() public view returns(uint256) {
        return _highScoreAndBlockHeight & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    }

    function getBlockHeight() public view returns (uint256) {
        return _highScoreAndBlockHeight>>224;
    }

    function getLatestMainChainCommitmentHash() public view returns (bytes32) {
        return getCommitment(getBlockHeight());
    }

    function getTargetFromHeader(uint256 nbits) private pure returns(uint256){
        return uint256(nBitsToTarget(nbits));
    }

    function getDifficulty(uint256 target) private pure returns(uint256){
        return 0x00000000FFFF0000000000000000000000000000000000000000000000000000 / target;
    }

    // Getters
    function getLatestForkHash(uint256 forkId) public view returns(bytes32){
        return _ongoingForks[forkId].forkHeaderHashes[_ongoingForks[forkId].forkHeaderHashes.length - 1]; 
    }

}
