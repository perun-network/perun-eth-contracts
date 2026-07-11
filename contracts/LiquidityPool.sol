// Copyright 2025 - See NOTICE file for copyright holders.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.15;

import "../vendor/openzeppelin-contracts/contracts/utils/Address.sol";
import "../vendor/openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import "../vendor/openzeppelin-contracts/contracts/access/Ownable.sol";

/**
 * @title LiquidityPool
 * @notice ETH-only liquidity pool for Perun channel funding and settlement,
 *         collateralized by an operator bond.
 * @dev Trust model: the operator borrows pool ETH via {fundChannel} and must
 *      return it (plus a protocol-enforced minimum fee) via {settleChannel}
 *      before the channel's deadline. Every borrowed wei is covered by the
 *      operator's bond ({operatorBond} >= {totalLockedETH} at all times), and
 *      once the deadline passes ANYONE may call {expireChannel} to repay the
 *      pool out of the bond. LPs therefore never depend on operator goodwill
 *      for principal; they only trust the operator for liveness of yield.
 *
 *      Share pricing: deposits mint and withdrawals redeem at the same
 *      {totalAssets} price, with an OZ-style +1 virtual share/asset offset so
 *      first-depositor share-price inflation is unprofitable. Rounding is
 *      always against the caller (in favor of the pool). LP yield accrues
 *      implicitly as ETH backing per share increases on fee-bearing
 *      settlements.
 *
 *      Invariants (see docs/liquidity-invariants.md in perun-eth-backend):
 *      - address(this).balance >= operatorBond          (bond is real ETH)
 *      - operatorBond >= totalLockedETH                 (full coverage)
 *      - totalAssets() == balance - operatorBond + totalLockedETH
 *      - {expireChannel} leaves totalAssets() unchanged (bond -> pool swap)
 */
contract LiquidityPool is ReentrancyGuard, Ownable {
    uint256 public constant BPS_DENOMINATOR = 10000;

    uint256 public totalShares;
    mapping(address => uint256) private _shares;

    address public operator;
    /// @notice Seconds the operator has to settle a funded channel before it
    ///         becomes expirable by anyone.
    uint256 public immutable settlementWindow;
    /// @notice Minimum settlement fee in basis points of the borrowed
    ///         principal, enforced on-chain in {settleChannel}.
    uint256 public immutable minFeeBps;
    /// @notice ETH the operator has posted as collateral. Held in the
    ///         contract balance but never part of LP assets.
    uint256 public operatorBond;

    mapping(bytes32 => uint256) public lockedByChannel;
    mapping(bytes32 => uint256) public channelDeadline;
    uint256 public totalLockedETH;

    event Deposited(
        address indexed provider,
        uint256 ethAmount,
        uint256 sharesMinted
    );

    event Withdrawn(
        address indexed provider,
        uint256 ethAmount,
        uint256 sharesBurned
    );

    event ChannelFunded(
        bytes32 indexed channelId,
        uint256 principal,
        address indexed operator,
        uint256 deadline
    );

    event ChannelSettled(
        bytes32 indexed channelId,
        uint256 principal,
        uint256 totalReturned,
        uint256 feeGain
    );

    event ChannelExpired(
        bytes32 indexed channelId,
        uint256 principal,
        address indexed caller
    );

    event BondPosted(
        address indexed operator,
        uint256 amount,
        uint256 newBond
    );

    event BondWithdrawn(
        address indexed operator,
        uint256 amount,
        uint256 newBond
    );

    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    modifier onlyOperator() {
        require(msg.sender == operator, "Only operator can call");
        _;
    }

    constructor(
        address _operator,
        uint256 _settlementWindow,
        uint256 _minFeeBps
    ) {
        require(_operator != address(0), "Invalid operator");
        require(_settlementWindow > 0, "Invalid settlement window");
        require(_minFeeBps < BPS_DENOMINATOR, "Invalid min fee");

        operator = _operator;
        settlementWindow = _settlementWindow;
        minFeeBps = _minFeeBps;
    }

    /// @dev Rotating the operator also hands control of the posted bond to
    ///      the new operator ({withdrawBond} pays the current operator).
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "Invalid operator");

        address previousOperator = operator;
        operator = newOperator;

        emit OperatorUpdated(previousOperator, newOperator);
    }

    function sharesOf(address provider) external view returns (uint256) {
        return _shares[provider];
    }

    /// @notice LP-owned assets: free liquidity plus outstanding channel
    ///         principal. Excludes the operator bond.
    function totalAssets() public view returns (uint256) {
        return address(this).balance - operatorBond + totalLockedETH;
    }

    /// @notice Free liquidity available for channel funding and withdrawals.
    ///         Excludes the operator bond.
    function withdrawableETH() public view returns (uint256) {
        return address(this).balance - operatorBond;
    }

    /// @notice Minimum msg.value {settleChannel} accepts for a channel:
    ///         principal plus the on-chain fee floor.
    function minSettlementValue(
        bytes32 channelId
    ) external view returns (uint256) {
        uint256 principal = lockedByChannel[channelId];
        return principal + (principal * minFeeBps) / BPS_DENOMINATOR;
    }

    function previewDepositShares(
        uint256 ethAmount
    ) external view returns (uint256) {
        return _toShares(ethAmount, totalAssets());
    }

    /// @notice Entitled ETH for burning sharesAmount at the {totalAssets}
    ///         price. {withdraw} additionally requires the result to fit in
    ///         free liquidity ({withdrawableETH}).
    function previewWithdrawETH(
        uint256 sharesAmount
    ) public view returns (uint256) {
        return (sharesAmount * (totalAssets() + 1)) / (totalShares + 1);
    }

    function deposit()
        external
        payable
        nonReentrant
        returns (uint256 mintedShares)
    {
        uint256 ethAmount = msg.value;
        require(ethAmount > 0, "Deposit must be > 0");

        // msg.value is already in the balance; price at pre-deposit assets.
        mintedShares = _toShares(ethAmount, totalAssets() - ethAmount);
        require(mintedShares > 0, "Minted shares = 0");

        _shares[msg.sender] += mintedShares;
        totalShares += mintedShares;

        emit Deposited(msg.sender, ethAmount, mintedShares);
    }

    /// @notice Redeems shares at the {totalAssets} price. Reverts when the
    ///         entitled ETH exceeds free liquidity — redeeming at a
    ///         free-balance price instead would silently underpay the LP
    ///         whenever channels hold principal.
    function withdraw(
        uint256 sharesToBurn
    ) external nonReentrant returns (uint256 ethAmountOut) {
        require(sharesToBurn > 0, "Shares must be > 0");

        uint256 providerShares = _shares[msg.sender];
        require(providerShares >= sharesToBurn, "Insufficient shares");

        ethAmountOut = previewWithdrawETH(sharesToBurn);
        require(ethAmountOut > 0, "Withdraw amount = 0");
        require(
            ethAmountOut <= withdrawableETH(),
            "Insufficient free liquidity"
        );

        _shares[msg.sender] = providerShares - sharesToBurn;
        totalShares -= sharesToBurn;

        Address.sendValue(payable(msg.sender), ethAmountOut);

        emit Withdrawn(msg.sender, ethAmountOut, sharesToBurn);
    }

    /// @notice Posts ETH collateral. Bond ETH is not LP money: it never
    ///         mints shares and is excluded from {totalAssets}.
    function bondETH() external payable onlyOperator {
        require(msg.value > 0, "Bond must be > 0");

        operatorBond += msg.value;

        emit BondPosted(msg.sender, msg.value, operatorBond);
    }

    /// @notice Withdraws bond down to the coverage floor: the remaining bond
    ///         must still cover every outstanding channel principal.
    function withdrawBond(
        uint256 amount
    ) external onlyOperator nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(amount <= operatorBond, "Insufficient bond");
        require(
            operatorBond - amount >= totalLockedETH,
            "Bond below coverage"
        );

        operatorBond -= amount;

        Address.sendValue(payable(operator), amount);

        emit BondWithdrawn(msg.sender, amount, operatorBond);
    }

    /// @notice Lends pool ETH to the operator for channel funding. Every
    ///         borrowed wei must be covered by bond, and the loan carries a
    ///         settlement deadline after which {expireChannel} repays the
    ///         pool from the bond.
    function fundChannel(
        bytes32 channelId,
        uint256 amount
    ) external onlyOperator nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(lockedByChannel[channelId] < 1, "Channel already funded");
        require(amount <= withdrawableETH(), "Insufficient free liquidity");
        require(
            operatorBond >= totalLockedETH + amount,
            "Insufficient bond coverage"
        );

        uint256 deadline = block.timestamp + settlementWindow;
        lockedByChannel[channelId] = amount;
        channelDeadline[channelId] = deadline;
        totalLockedETH += amount;

        Address.sendValue(payable(operator), amount);

        emit ChannelFunded(channelId, amount, operator, deadline);
    }

    /// @notice Returns borrowed principal plus at least the fee floor. The
    ///         full msg.value stays in the pool; the surplus over principal
    ///         is LP yield.
    function settleChannel(
        bytes32 channelId
    ) external payable onlyOperator nonReentrant {
        uint256 principal = lockedByChannel[channelId];
        require(principal > 0, "Unknown channel");
        require(
            msg.value >=
                principal + (principal * minFeeBps) / BPS_DENOMINATOR,
            "Returned ETH below principal plus fee floor"
        );

        totalLockedETH -= principal;
        delete lockedByChannel[channelId];
        delete channelDeadline[channelId];

        emit ChannelSettled(
            channelId,
            principal,
            msg.value,
            msg.value - principal
        );
    }

    /// @notice Repays an overdue channel's principal to the pool out of the
    ///         operator bond. Callable by ANYONE once the deadline passed, so
    ///         LP solvency does not depend on the owner or operator acting.
    /// @dev Pure accounting move: the slashed ETH is already in the contract
    ///      balance, so totalAssets() is unchanged — the pool swaps its
    ///      locked claim for bond ETH. Cannot underflow: the coverage
    ///      invariant guarantees operatorBond >= totalLockedETH >= principal.
    function expireChannel(bytes32 channelId) external nonReentrant {
        uint256 principal = lockedByChannel[channelId];
        require(principal > 0, "Unknown channel");
        require(block.timestamp > channelDeadline[channelId], "Not expired");

        operatorBond -= principal;
        totalLockedETH -= principal;
        delete lockedByChannel[channelId];
        delete channelDeadline[channelId];

        emit ChannelExpired(channelId, principal, msg.sender);
    }

    /// @dev Converts ETH to shares at the assetsBefore price with a +1
    ///      virtual share/asset offset (rounds against the depositor).
    function _toShares(
        uint256 ethAmount,
        uint256 assetsBefore
    ) internal view returns (uint256) {
        return (ethAmount * (totalShares + 1)) / (assetsBefore + 1);
    }

    receive() external payable {
        revert("Use deposit, bondETH or settleChannel");
    }
}
