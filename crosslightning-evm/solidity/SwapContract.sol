import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import "../btcrelay-sol/BTCRelay_commit_pruned_tsfix.sol";
import "./BitcoinTxUtils.sol";

contract CrossLightningSwaps {

    uint256 constant public SECURITY_DEPOSIT = 0.05 ether;

    uint256 constant KIND_LN = 0;
    uint256 constant KIND_CHAIN = 1;
    uint256 constant KIND_CHAIN_NONCED = 2;

    BTCRelay immutable btcRelay;

    constructor(BTCRelay _btcRelay) {
        btcRelay = _btcRelay;
    }

    struct TransactionProof {
        uint256 blockheight;
        uint256 txPos;
        bytes merkleProof;
        BTCRelay.HeaderInfo committedHeader;
    }

    struct AtomicSwapStruct {
        address offerer;
        address claimer;
        
        address token;

        uint256 amount;
        bytes32 paymentHash;
        
        uint256 data; //expiry: uint64, nonce: uint64, confirmations: uint16, kind: uint8, payIn: uint8, payOut: uint8, index: uint8
    }

    struct Signature {
        bytes32 r;
        bytes32 s;
        uint256 vAndTimeout; //v: uint8, timeout: uint64
    }
    
    struct Reputation {
        uint256 success; //amount: uint224, count: uint32
        uint256 coopClose; //amount: uint224, count: uint32
        uint256 failed; //amount: uint224, count: uint32
    }

    mapping(bytes32 => bytes32) public commitments; //Map payment hash to commit hash
    mapping(address => mapping(address => uint256)) public balances;
    mapping(address => mapping(address => mapping(uint256 => Reputation))) public reputation;

    event Initialize(address indexed offerer, address indexed claimer, bytes32 indexed paymentHash, AtomicSwapStruct data, bytes32 txoHash);
    event Claim(address indexed offerer, address indexed claimer, bytes32 indexed paymentHash, bytes32 secret);
    event Refund(address indexed offerer, address indexed claimer, bytes32 indexed paymentHash);
    
    function getAddress(bytes32 commitment, Signature calldata sig, bytes memory kind) private view returns (address) {
        uint64 timeout = uint64((sig.vAndTimeout >> 8) & 0xFFFFFFFFFFFFFFFF);
        require(timeout>block.timestamp, "Expired");
        bytes32 hashedMessage = keccak256(abi.encodePacked(
            kind,
            commitment,
            timeout
        ));

        bytes memory prefix = "\x19Ethereum Signed Message:\n32";
        bytes32 prefixedHashMessage = keccak256(abi.encodePacked(prefix, hashedMessage));
        
        return ecrecover(prefixedHashMessage, uint8(sig.vAndTimeout & 0xFF), sig.r, sig.s);
    }

    function getReputation(address who, address token) external view returns (Reputation[3] memory) {
        Reputation[3] memory result;
        result[0] = reputation[who][token][0];
        result[1] = reputation[who][token][1];
        result[2] = reputation[who][token][2];
        return result;
    }

    /*
        0x00 - never tried
        0x01-0xFF - retries
        0x100 - success
        >0x100 - commit hash
    */
    function getCommitment(bytes32 paymentHash) external view returns (bytes32) {
        return commitments[paymentHash];
    }

    function balanceOf(address who, address token) external view returns (uint256) {
        return balances[who][token];
    }

    function myBalance(address token) external view returns (uint256) {
        return balances[msg.sender][token];
    }

    function transferIn(address token, uint256 amount) private {
        if(token==address(0x00)) {
            require(msg.value>=amount, "Invalid deposit amount");
        } else {
            TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        }
    }

    function transferOut(address token, address recipient, uint256 amount) private {
        if(token==address(0x00)) {
            payable(recipient).transfer(amount);
        } else {
            TransferHelper.safeTransfer(token, recipient, amount);
        }
    }

    function deposit(address token, uint256 amount) payable external {
        transferIn(token, amount);
        balances[msg.sender][token] += amount;
    }

    function withdraw(address token, uint256 amount) external {
        uint256 balance = balances[msg.sender][token];
        require(balance>=amount, "Insufficient funds");

        transferOut(token, msg.sender, amount);
        balances[msg.sender][token] = balance - amount;
    }

    //Initiate an invoice payment
    function offerer_claimInit(AtomicSwapStruct memory payReq, Signature calldata signature, bytes32 txoHash) payable external returns(bytes32) {
        uint256 index = (payReq.data >> 168) & 0xFF;
        require(commitments[payReq.paymentHash]==bytes32(uint256(index)), "Invalid index");
        require(msg.sender == payReq.offerer, "Offerer must be sender");
        uint256 payIn = (payReq.data >> 152) & 0xFF;
        require(payIn>0, "Must be payIn");

        //TODO: Check if calldata structs are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        address sender = getAddress(commitment, signature, "claim_initialize");
        require(payReq.claimer==sender, "Invalid signature");

        transferIn(payReq.token, payReq.amount);

        commitments[payReq.paymentHash] = commitment;

        emit Initialize(payReq.offerer, payReq.claimer, payReq.paymentHash, payReq, txoHash);

        return commitment;
    }

    //Intiate a payment on behalf of user
    function offerer_init(AtomicSwapStruct memory payReq, Signature calldata signature, bytes32 txoHash) payable external returns(bytes32) {
        require(msg.value>=SECURITY_DEPOSIT, "Invalid amount deposited");
        uint256 expiry = payReq.data & 0xFFFFFFFFFFFFFFFF;
        require(expiry > block.timestamp, "Request already expired");
        uint256 index = (payReq.data >> 168) & 0xFF;
        require(commitments[payReq.paymentHash]==bytes32(uint256(index)), "Invalid index");
        uint256 payIn = (payReq.data >> 152) & 0xFF;
        require(payIn==0, "Must be NOT payIn");

        uint256 balance = balances[payReq.offerer][payReq.token];
        require(balance >= payReq.amount, "Insufficient funds");
        
        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        address sender = getAddress(commitment, signature, "initialize");
        require(payReq.offerer==sender, "Invalid signature");

        balances[sender][payReq.token] = balance - payReq.amount;

        commitments[payReq.paymentHash] = commitment;

        emit Initialize(payReq.offerer, payReq.claimer, payReq.paymentHash, payReq, txoHash);

        return commitment;
    }

    //Refund back to the offerer after enough time has passed
    function offerer_refund(AtomicSwapStruct memory payReq) public {
        uint256 expiry = payReq.data & 0xFFFFFFFFFFFFFFFF;
        require(expiry<block.timestamp, "Not refundable, yet");
        require(msg.sender==payReq.offerer, "Must be offerer");

        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        require(commitments[payReq.paymentHash]==commitment, "Payment request not commited!");

        uint256 payIn = (payReq.data >> 152) & 0xFF;
        uint256 kind = (payReq.data >> 144) & 0xFF;
        if(payIn>0) {
            transferOut(payReq.token, payReq.offerer, payReq.amount);
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].failed;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].failed = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        } else {
            balances[payReq.offerer][payReq.token] += payReq.amount;
            payable(msg.sender).transfer(SECURITY_DEPOSIT);
        }

        uint256 index = (payReq.data >> 168) & 0xFF;
        if(index<0xFF) index++;
        commitments[payReq.paymentHash] = bytes32(index);

        emit Refund(payReq.offerer, payReq.claimer, payReq.paymentHash);
    }
    
    //Refund back to the offerer prematurely with claimer's signature
    function offerer_refundWithAuth(AtomicSwapStruct memory payReq, Signature calldata signature) public {
        require(msg.sender==payReq.offerer, "Must be offerer");

        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        require(commitments[payReq.paymentHash]==commitment, "Payment request not commited!");

        address sender = getAddress(commitment, signature, "refund");
        require(payReq.claimer==sender, "Invalid signature");

        uint256 payIn = (payReq.data >> 152) & 0xFF;
        uint256 kind = (payReq.data >> 144) & 0xFF;
        if(payIn>0) {
            transferOut(payReq.token, payReq.offerer, payReq.amount);
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].coopClose;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].coopClose = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        } else {
            balances[payReq.offerer][payReq.token] += payReq.amount;
            payable(msg.sender).transfer(SECURITY_DEPOSIT);
        }

        uint256 index = (payReq.data >> 168) & 0xFF;
        if(index<0xFF) index++;
        commitments[payReq.paymentHash] = bytes32(index);

        emit Refund(payReq.offerer, payReq.claimer, payReq.paymentHash);
    }

    // function _refundSingleNoSend(address offerer, AtomicSwapStruct calldata payReq, address token) private returns (uint256) {
    //     require(payReq.expiry<block.timestamp, "Not refundable, yet");
    //     require(payReq.token==token, "Invalid token in payment request");
    //     require(commitments[payReq.paymentHash]==keccak256(abi.encode(offerer, payReq)), "Payment request not commited!");

    //     commitments[payReq.paymentHash] = bytes32(0x00);

    //     emit Refund(offerer, payReq.intermediary, payReq.paymentHash);

    //     return payReq.amount;
    // }

    // function offerer_refund_payInvoice(AtomicSwapStruct[] calldata payReqs, AtomicSwapStruct calldata newPayReq) external {
    //     require(commitments[newPayReq.paymentHash]==bytes32(0x00), "Invoice already paid or getting paid");

    //     uint256 totalLocked = 0;

    //     for(uint i=0;i<payReqs.length;i++) {
    //         totalLocked += _refundSingleNoSend(msg.sender, payReqs[i], newPayReq.token);
    //     }

    //     if(totalLocked>newPayReq.amount) {
    //         //One tx goes to dst, one back to msg.sender
    //         balances[msg.sender][newPayReq.token] += totalLocked-newPayReq.amount;
    //     } else if(totalLocked<newPayReq.amount) {
    //         uint256 currentBalance = balances[msg.sender][newPayReq.token];
    //         uint256 totalDebit = newPayReq.amount-totalLocked;
    //         require(currentBalance>=totalDebit, "Insufficient balance");
    //         balances[msg.sender][newPayReq.token] = currentBalance-totalDebit;
    //     }

    //     commitments[newPayReq.paymentHash] = keccak256(abi.encode(msg.sender, newPayReq));

    //     emit Initialize(msg.sender, newPayReq.intermediary, newPayReq.paymentHash, newPayReq);
    // }

    function _refundSingleNoSendNoRevert(AtomicSwapStruct memory payReq) private returns (uint256) {
        if(msg.sender!=payReq.offerer) return 0; //"Must be offerer"
        uint256 expiry = payReq.data & 0xFFFFFFFFFFFFFFFF;
        if(!(expiry<block.timestamp)) return 0; //Not refundable, yet

        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        if(!(commitments[payReq.paymentHash]==commitment)) return 0; //Payment request not commited!

        uint256 index = (payReq.data >> 168) & 0xFF;
        if(index<0xFF) index++;
        commitments[payReq.paymentHash] = bytes32(index);

        uint256 kind = (payReq.data >> 144) & 0xFF;
        if(((payReq.data >> 152) & 0xFF)>0) {
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].failed;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].failed = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        }

        emit Refund(payReq.offerer, payReq.claimer, payReq.paymentHash);

        return payReq.amount;
    }

    //Payment requests must be ordered in a way that requests with the same token address will be grouped together, this is done to minimize the gas cost of running this function
    function offerer_multi_refund(AtomicSwapStruct[] memory payReqs, bool payIn) public {
        uint256 count;
        uint256 totalLocked;
        address currentToken;

        for(uint i=0;i<payReqs.length;i++) {
            bool isPayIn = ((payReqs[i].data >> 152) & 0xFF)>0;
            if(isPayIn != payIn) continue;
            if(currentToken!=payReqs[i].token && totalLocked>0) {
                if(payIn) {
                    transferOut(currentToken, msg.sender, totalLocked);
                } else {
                    balances[msg.sender][currentToken] += totalLocked;
                }
                totalLocked = 0;
            }

            uint256 amountRefunded = _refundSingleNoSendNoRevert(payReqs[i]);
            if(!isPayIn && amountRefunded>0) count++;
            totalLocked += amountRefunded;
            currentToken = payReqs[i].token;
        }

        if(totalLocked>0) {
            if(payIn) {
                transferOut(currentToken, msg.sender, totalLocked);
            } else {
                balances[msg.sender][currentToken] += totalLocked;
            }
        }

        if(count>0) payable(msg.sender).transfer(SECURITY_DEPOSIT*count);

    }

    function _refundSingleNoSendNoRevert(AtomicSwapStruct memory payReq, Signature calldata signature) private returns (uint256) {
        if(msg.sender!=payReq.offerer) return 0; //"Must be offerer"

        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        if(!(commitments[payReq.paymentHash]==commitment)) return 0; //Payment request not commited!

        address sender = getAddress(commitment, signature, "refund");
        if(payReq.claimer!=sender) return 0; //Invalid signature

        uint256 index = (payReq.data >> 168) & 0xFF;
        if(index<0xFF) index++;
        commitments[payReq.paymentHash] = bytes32(index);

        uint256 kind = (payReq.data >> 144) & 0xFF;
        if(((payReq.data >> 152) & 0xFF)>0) {
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].coopClose;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].coopClose = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        }

        emit Refund(payReq.offerer, payReq.claimer, payReq.paymentHash);

        return payReq.amount;
    }
    
    function offerer_multi_refundWithAuth(AtomicSwapStruct[] memory payReqs, bool payIn, Signature[] calldata signatures) public {
        uint256 count;
        uint256 totalLocked;
        address currentToken;

        for(uint i=0;i<payReqs.length;i++) {
            bool isPayIn = ((payReqs[i].data >> 152) & 0xFF)>0;
            if(isPayIn != payIn) continue;
            if(currentToken!=payReqs[i].token && totalLocked>0) {
                if(payIn) {
                    transferOut(currentToken, msg.sender, totalLocked);
                } else {
                    balances[msg.sender][currentToken] += totalLocked;
                }
                totalLocked = 0;
            }

            uint256 amountRefunded = _refundSingleNoSendNoRevert(payReqs[i], signatures[i]);
            if(!isPayIn && amountRefunded>0) count++;
            totalLocked += amountRefunded;
            currentToken = payReqs[i].token;
        }

        if(totalLocked>0) {
            if(payIn) {
                transferOut(currentToken, msg.sender, totalLocked);
            } else {
                balances[msg.sender][currentToken] += totalLocked;
            }
        }

        if(count>0) payable(msg.sender).transfer(SECURITY_DEPOSIT*count);

    }

    function claimer_claim(AtomicSwapStruct memory payReq, bytes32 secret) public {
        uint256 expiry = payReq.data & 0xFFFFFFFFFFFFFFFF;
        require(payReq.claimer==msg.sender, "Sender must be claimer");
        require(expiry>=block.timestamp, "Not claimable anymore"); //Not sure if this is necessary, but improves security for payer
        
        uint256 kind = (payReq.data >> 144) & 0xFF;
        require(kind==KIND_LN, "Invalid type");

        //TODO: Check if calldata struct are maybe tightly packed?
        bytes32 commitment;
        assembly {
            commitment := keccak256(payReq, 192)
        }

        require(commitments[payReq.paymentHash]==commitment, "Payment request not commited!");

        require(payReq.paymentHash==sha256(abi.encodePacked(secret)), "Invalid secret");

        uint256 payOut = (payReq.data >> 160) & 0xFF;
        if(payOut>0) {
            transferOut(payReq.token, payReq.claimer, payReq.amount);
        } else {
            balances[payReq.claimer][payReq.token] += payReq.amount;
        }
        commitments[payReq.paymentHash] = bytes32(uint256(0x100));

        uint256 payIn = (payReq.data >> 152) & 0xFF;
        if(payIn==0) {
            payable(msg.sender).transfer(SECURITY_DEPOSIT);
        } else {
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].success;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].success = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        }

        emit Claim(payReq.offerer, payReq.claimer, payReq.paymentHash, secret);
    }

    function claimer_claimWithTxData(AtomicSwapStruct memory payReq, uint256 vout, bytes memory txData, TransactionProof calldata proof) public {
        uint256 expiry = payReq.data & 0xFFFFFFFFFFFFFFFF;
        require(expiry>=block.timestamp, "Not claimable anymore"); //Not sure if this is necessary, but improves security for payer

        uint256 kind = (payReq.data >> 144) & 0xFF;
        require(kind==KIND_CHAIN || kind==KIND_CHAIN_NONCED, "Invalid type");

        {
            //TODO: Check if calldata struct are maybe tightly packed?
            bytes32 commitment;
            assembly {
                commitment := keccak256(payReq, 192)
            }

            require(commitments[payReq.paymentHash]==commitment, "Payment request not commited!");
        }

        bytes32 txId;
        
        {
            (bytes32 _txId, bytes32 txoHash, uint256 sequence, uint256 locktime) = BitcoinTxUtils.verifyTransaction(txData, vout, kind==KIND_CHAIN_NONCED);
            uint256 swapNonce = (payReq.data >> 64) & 0xFFFFFFFFFFFFFFFF;
            if(kind==KIND_CHAIN_NONCED) {
                //Check nonce
                uint256 txNonce = ((locktime-500000000)<<24) | sequence;
                require(swapNonce==txNonce, "Invalid nonce");
            }

            assembly {
                let freeMemPtr := mload(0x40)
                mstore(freeMemPtr, shl(192,swapNonce))
                mstore(add(freeMemPtr, 8), txoHash)
                txoHash := keccak256(freeMemPtr, 40)
            }
            require(txoHash==payReq.paymentHash, "Invalid txout");

            txId = _txId;
        }


        uint256 confirmations = (payReq.data >> 128) & 0xFFFF;

        require(
            btcRelay.verifyTX(txId, proof.blockheight, proof.txPos, proof.merkleProof, confirmations, proof.committedHeader),
            "Tx verification failed"
        );

        uint256 payOut = (payReq.data >> 160) & 0xFF;
        if(payOut>0) {
            transferOut(payReq.token, payReq.claimer, payReq.amount);
        } else {
            balances[payReq.claimer][payReq.token] += payReq.amount;
        }
        commitments[payReq.paymentHash] = bytes32(uint256(0x100));

        uint256 payIn = (payReq.data >> 152) & 0xFF;
        if(payIn==0) {
            payable(msg.sender).transfer(SECURITY_DEPOSIT);
        } else {
            uint256 rep = reputation[payReq.claimer][payReq.token][kind].success;
            uint256 amount = (rep & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)+payReq.amount;
            uint256 count = (rep >> 224)+1;
            reputation[payReq.claimer][payReq.token][kind].success = 
                (count << 224) |
                (amount & 0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
        }

        emit Claim(payReq.offerer, payReq.claimer, payReq.paymentHash, txId);
    }

}
