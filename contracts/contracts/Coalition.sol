// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Coalition — N-party atomic-commit escrow for digital volume-tier coalitions
/// @notice Buyers fund equal slices of a single bulk reservation. KeeperHub commits if the
///         full set funds before the deadline; otherwise everyone is refunded. No partial state.
contract Coalition is ReentrancyGuard {
    enum State { Forming, Funded, Committed, Refunded }

    address public immutable seller;
    address public immutable keeper;       // KeeperHub-authorized address
    bytes32 public immutable skuHash;
    uint256 public immutable tierUnitPrice; // payToken units per unit (e.g. 1500000 = $1.50 USDC)
    uint256 public immutable unitQty;       // qty per buyer
    uint256 public immutable requiredBuyers;
    uint256 public immutable validUntil;
    IERC20  public immutable payToken;

    State   public state;
    address[] public buyers;
    mapping(address => uint256) public funded;
    uint256 public totalFunded;

    event BuyerFunded(address indexed buyer, uint256 amount, uint256 fundedCount);
    event CoalitionCommitted(uint256 totalPaid);
    event CoalitionRefunded(uint256 refundCount);

    error WrongState();
    error Expired();
    error NotKeeper();
    error AlreadyFunded();
    error TransferFailed();

    constructor(
        bytes32 _skuHash,
        uint256 _tierUnitPrice,
        uint256 _unitQty,
        uint256 _requiredBuyers,
        uint256 _validUntil,
        address _seller,
        address _keeper,
        address _payToken
    ) {
        skuHash         = _skuHash;
        tierUnitPrice   = _tierUnitPrice;
        unitQty         = _unitQty;
        requiredBuyers  = _requiredBuyers;
        validUntil      = _validUntil;
        seller          = _seller;
        keeper          = _keeper;
        payToken        = IERC20(_payToken);
        state           = State.Forming;
    }

    /// @notice Buyer deposits their slice of the coalition's pooled payment.
    /// @dev Caller must approve `tierUnitPrice * unitQty` of payToken to this contract.
    function fund() external nonReentrant {
        if (state != State.Forming) revert WrongState();
        if (block.timestamp > validUntil) revert Expired();
        if (funded[msg.sender] != 0) revert AlreadyFunded();

        uint256 amount = tierUnitPrice * unitQty;
        if (!payToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        funded[msg.sender] = amount;
        buyers.push(msg.sender);
        totalFunded += amount;

        emit BuyerFunded(msg.sender, amount, buyers.length);

        if (buyers.length == requiredBuyers) {
            state = State.Funded;
        }
    }

    /// @notice KeeperHub commits the coalition once all required buyers have funded.
    function commit() external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (state != State.Funded) revert WrongState();

        state = State.Committed;
        if (!payToken.transfer(seller, totalFunded)) revert TransferFailed();

        emit CoalitionCommitted(totalFunded);
    }

    /// @notice Refunds all funded buyers. Callable by keeper any time during Forming/Funded,
    ///         OR by anyone once validUntil has elapsed without commit (liveness fallback).
    function refundAll() external nonReentrant {
        if (state != State.Forming && state != State.Funded) revert WrongState();
        if (msg.sender != keeper && block.timestamp <= validUntil) revert NotKeeper();

        state = State.Refunded;
        uint256 n = buyers.length;
        for (uint256 i = 0; i < n; i++) {
            address b = buyers[i];
            uint256 amount = funded[b];
            if (amount > 0) {
                funded[b] = 0;
                if (!payToken.transfer(b, amount)) revert TransferFailed();
            }
        }
        emit CoalitionRefunded(n);
    }

    function buyerCount() external view returns (uint256) {
        return buyers.length;
    }

    function unitPriceTotal() external view returns (uint256) {
        return tierUnitPrice * unitQty;
    }
}
