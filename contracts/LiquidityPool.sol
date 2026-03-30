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
 * @notice ETH-only liquidity pool for Perun channel funding and settlement.
 * @dev LP yield accrues implicitly as ETH backing per share increases on
 *      fee-bearing channel settlements.
 */
contract LiquidityPool is ReentrancyGuard, Ownable {
    uint256 public totalShares;
    mapping(address => uint256) private _shares;

    address public operator;
    mapping(bytes32 => uint256) public lockedByChannel;
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
        address indexed operator
    );

    event ChannelSettled(
        bytes32 indexed channelId,
        uint256 principal,
        uint256 totalReturned,
        uint256 feeGain
    );

    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    modifier onlyOperator() {
        require(msg.sender == operator, "Only operator can call");
        _;
    }

    constructor(address _operator) {
        require(_operator != address(0), "Invalid operator");
        operator = _operator;
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "Invalid operator");

        address previousOperator = operator;
        operator = newOperator;

        emit OperatorUpdated(previousOperator, newOperator);
    }

    function sharesOf(address provider) external view returns (uint256) {
        return _shares[provider];
    }

    function totalAssets() public view returns (uint256) {
        return address(this).balance + totalLockedETH;
    }

    function withdrawableETH() public view returns (uint256) {
        return address(this).balance;
    }

    function previewDepositShares(
        uint256 ethAmount
    ) external view returns (uint256) {
        if (ethAmount < 1) {
            return 0;
        }

        if (totalShares < 1) {
            return ethAmount;
        }

        return (ethAmount * totalShares) / totalAssets();
    }

    function previewWithdrawETH(
        uint256 sharesAmount
    ) external view returns (uint256) {
        if (sharesAmount < 1 || totalShares < 1) {
            return 0;
        }

        return (sharesAmount * withdrawableETH()) / totalShares;
    }

    function deposit()
        external
        payable
        nonReentrant
        returns (uint256 mintedShares)
    {
        uint256 ethAmount = msg.value;
        require(ethAmount > 0, "Deposit must be > 0");

        if (totalShares < 1) {
            mintedShares = ethAmount;
        } else {
            uint256 assetsBefore = totalAssets() - ethAmount;
            mintedShares = (ethAmount * totalShares) / assetsBefore;
        }

        require(mintedShares > 0, "Minted shares = 0");

        _shares[msg.sender] += mintedShares;
        totalShares += mintedShares;

        emit Deposited(msg.sender, ethAmount, mintedShares);
    }

    function withdraw(
        uint256 sharesToBurn
    ) external nonReentrant returns (uint256 ethAmountOut) {
        require(sharesToBurn > 0, "Shares must be > 0");

        uint256 providerShares = _shares[msg.sender];
        require(providerShares >= sharesToBurn, "Insufficient shares");

        ethAmountOut = (sharesToBurn * withdrawableETH()) / totalShares;
        require(ethAmountOut > 0, "Withdraw amount = 0");

        _shares[msg.sender] = providerShares - sharesToBurn;
        totalShares -= sharesToBurn;

        Address.sendValue(payable(msg.sender), ethAmountOut);

        emit Withdrawn(msg.sender, ethAmountOut, sharesToBurn);
    }

    function fundChannel(
        bytes32 channelId,
        uint256 amount
    ) external onlyOperator nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(lockedByChannel[channelId] < 1, "Channel already funded");
        require(amount <= withdrawableETH(), "Insufficient free liquidity");

        lockedByChannel[channelId] = amount;
        totalLockedETH += amount;

        Address.sendValue(payable(operator), amount);

        emit ChannelFunded(channelId, amount, operator);
    }

    function settleChannel(
        bytes32 channelId
    ) external payable onlyOperator nonReentrant {
        uint256 principal = lockedByChannel[channelId];
        require(principal > 0, "Unknown channel");
        require(msg.value >= principal, "Returned ETH below principal");

        totalLockedETH -= principal;
        delete lockedByChannel[channelId];

        emit ChannelSettled(
            channelId,
            principal,
            msg.value,
            msg.value - principal
        );
    }

    receive() external payable {
        revert("Use deposit or settleChannel");
    }
}
