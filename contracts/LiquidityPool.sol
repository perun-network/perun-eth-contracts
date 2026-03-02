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
import "../vendor/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "../vendor/openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import "../vendor/openzeppelin-contracts/contracts/access/Ownable.sol";

/**
 * @title LiquidityPool
 * @notice Manages liquidity pools for CKB-ETH atomic swaps via Perun channels
 * @dev Works in conjunction with Perun Adjudicator and AssetHolder contracts
 */
contract LiquidityPool is ReentrancyGuard, Ownable {
    // LP Position struct
    struct LPPosition {
        address provider;
        uint256 ethAmount;
        uint256 ckbAmount;
        uint256 lpShares;
        uint256 accumulatedFeesETH;
        uint256 accumulatedFeesCKB;
        uint256 entryTimestamp;
        bool active;
    }

    // Pool state
    struct PoolState {
        uint256 totalETHLiquidity;
        uint256 totalCKBLiquidity;
        uint256 totalLPShares;
        uint256 accumulatedSwapFeeETH;
        uint256 accumulatedSwapFeeCKB;
        uint256 swapCount;
        uint16 feeRateBasisPoints; // e.g., 30 = 0.3%
        uint256 lastUpdateTimestamp;
    }

    struct HubReservation {
        uint256 ethReserved; // ETH locked for active channels
        uint256 ckbReserved; // CKB locked for active channels
        uint256 timestamp;
    }

    // ============ STATE VARIABLES ============

    PoolState public poolState;
    mapping(address => LPPosition) public lpPositions;
    mapping(bytes32 => bool) public processedSwaps;

    // Hub management
    address public hubAddress; // Authorized hub operator
    mapping(bytes32 => HubReservation) public channelReservations; // channelID → reserved funds
    uint256 public totalETHReserved; // Total ETH locked in active channels
    uint256 public totalCKBReserved; // Total CKB locked in active channels

    // Constants
    uint256 public constant MIN_LIQUIDITY = 1000;
    uint256 public constant FEE_DENOMINATOR = 10000;
    uint256 public constant MAX_RESERVATION_TIME = 24 hours;

    // ============ EVENTS ============

    event LiquidityAdded(
        address indexed provider,
        uint256 ethAmount,
        uint256 ckbAmount,
        uint256 lpShares
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 ethAmount,
        uint256 ckbAmount,
        uint256 lpShares
    );

    event FundsReservedForChannel(
        bytes32 indexed channelId,
        uint256 ethAmount,
        uint256 ckbAmount
    );

    event FundsExtractedToHub(
        bytes32 indexed channelId,
        uint256 ethAmount,
        address hubAddress
    );

    event ChannelSettled(
        bytes32 indexed channelId,
        uint256 ethReturned,
        uint256 ckbReturned,
        uint256 ethFees,
        uint256 ckbFees
    );

    event SwapExecuted(
        bytes32 indexed swapId,
        bytes32 indexed channelId,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 fee,
        bool inputIsETH
    );

    event FeesDistributed(uint256 ethFees, uint256 ckbFees);

    event HubUpdated(address indexed previousHub, address indexed newHub);

    // ============ MODIFIERS ============

    modifier onlyHub() {
        require(msg.sender == hubAddress, "Only hub can call");
        _;
    }

    modifier validChannelReservation(bytes32 channelId) {
        require(
            channelReservations[channelId].timestamp > 0,
            "Channel not reserved"
        );
        require(
            block.timestamp <=
                channelReservations[channelId].timestamp + MAX_RESERVATION_TIME,
            "Reservation expired"
        );
        _;
    }

    // ============ CONSTRUCTOR ============

    constructor(address _hubAddress, uint16 _feeRateBasisPoints) {
        require(_hubAddress != address(0), "Invalid hub address");
        require(_feeRateBasisPoints <= 1000, "Fee too high"); // Max 10%

        hubAddress = _hubAddress;
        poolState.feeRateBasisPoints = _feeRateBasisPoints;
        poolState.lastUpdateTimestamp = block.timestamp;
    }

    // ============ LIQUIDITY PROVIDER FUNCTIONS ============

    /**
     * @notice Add liquidity to the pool
     * @param ckbAmount Virtual CKB amount (tracked off-chain)
     * @dev ETH amount is msg.value
     */
    function addLiquidity(
        uint256 ckbAmount
    ) external payable nonReentrant returns (uint256 lpShares) {
        require(msg.value > 0, "Must deposit ETH");
        require(ckbAmount > 0, "Must specify CKB amount");

        LPPosition storage position = lpPositions[msg.sender];

        // Calculate LP shares using constant product formula
        if (poolState.totalLPShares == 0) {
            // Initial liquidity: shares = sqrt(eth * ckb)
            lpShares = sqrt(msg.value * ckbAmount);
            require(
                lpShares >= MIN_LIQUIDITY,
                "Insufficient initial liquidity"
            );
        } else {
            // Proportional liquidity: maintain pool ratio
            uint256 ethShares = (msg.value * poolState.totalLPShares) /
                poolState.totalETHLiquidity;
            uint256 ckbShares = (ckbAmount * poolState.totalLPShares) /
                poolState.totalCKBLiquidity;

            // Take minimum to maintain ratio (excess is refunded)
            lpShares = ethShares < ckbShares ? ethShares : ckbShares;
            require(lpShares > 0, "Insufficient liquidity amount");
        }

        // Update or create LP position
        if (position.active) {
            position.ethAmount += msg.value;
            position.ckbAmount += ckbAmount;
            position.lpShares += lpShares;
        } else {
            position.provider = msg.sender;
            position.ethAmount = msg.value;
            position.ckbAmount = ckbAmount;
            position.lpShares = lpShares;
            position.entryTimestamp = block.timestamp;
            position.active = true;
        }

        // Update pool state
        poolState.totalETHLiquidity += msg.value;
        poolState.totalCKBLiquidity += ckbAmount;
        poolState.totalLPShares += lpShares;
        poolState.lastUpdateTimestamp = block.timestamp;

        emit LiquidityAdded(msg.sender, msg.value, ckbAmount, lpShares);
    }

    /**
     * @notice Remove liquidity from the pool
     * @param lpShares Amount of LP shares to burn
     */
    function removeLiquidity(
        uint256 lpShares
    ) external nonReentrant returns (uint256 ethAmount, uint256 ckbAmount) {
        LPPosition storage position = lpPositions[msg.sender];
        require(position.active, "No active position");
        require(position.lpShares >= lpShares, "Insufficient LP shares");

        // Calculate proportional withdrawal
        uint256 availableETH = poolState.totalETHLiquidity - totalETHReserved;
        uint256 availableCKB = poolState.totalCKBLiquidity - totalCKBReserved;

        ethAmount = (lpShares * availableETH) / poolState.totalLPShares;
        ckbAmount = (lpShares * availableCKB) / poolState.totalLPShares;

        require(
            ethAmount > 0 && ckbAmount > 0,
            "Insufficient available liquidity"
        );

        // Update position
        position.ethAmount -= ethAmount;
        position.ckbAmount -= ckbAmount;
        position.lpShares -= lpShares;

        if (position.lpShares == 0) {
            position.active = false;
        }

        // Update pool state
        poolState.totalETHLiquidity -= ethAmount;
        poolState.totalCKBLiquidity -= ckbAmount;
        poolState.totalLPShares -= lpShares;
        poolState.lastUpdateTimestamp = block.timestamp;

        _safeTransferETH(msg.sender, ethAmount);

        emit LiquidityRemoved(msg.sender, ethAmount, ckbAmount, lpShares);
    }

    // ============ HUB CHANNEL FUNDING FUNCTIONS ============

    /**
     * @notice Reserve liquidity for a new Perun channel
     * @param channelId Unique channel identifier
     * @param ethAmount ETH required for channel
     * @param ckbAmount CKB required for channel
     */
    function reserveForChannel(
        bytes32 channelId,
        uint256 ethAmount,
        uint256 ckbAmount
    ) external onlyHub {
        require(
            channelReservations[channelId].timestamp == 0,
            "Channel already reserved"
        );

        uint256 availableETH = poolState.totalETHLiquidity - totalETHReserved;
        uint256 availableCKB = poolState.totalCKBLiquidity - totalCKBReserved;

        require(ethAmount <= availableETH, "Insufficient ETH liquidity");
        require(ckbAmount <= availableCKB, "Insufficient CKB liquidity");

        // Create reservation
        channelReservations[channelId] = HubReservation({
            ethReserved: ethAmount,
            ckbReserved: ckbAmount,
            timestamp: block.timestamp
        });

        totalETHReserved += ethAmount;
        totalCKBReserved += ckbAmount;

        emit FundsReservedForChannel(channelId, ethAmount, ckbAmount);
    }

    /**
     * @notice Extract reserved ETH to hub for Perun channel funding
     * @param channelId Channel to fund
     * @dev This transfers ETH from pool to hub wallet → hub deposits to AssetHolder
     */
    function extractToHub(
        bytes32 channelId
    ) external onlyHub validChannelReservation(channelId) nonReentrant {
        HubReservation memory reservation = channelReservations[channelId];

        _safeTransferETH(hubAddress, reservation.ethReserved);

        emit FundsExtractedToHub(
            channelId,
            reservation.ethReserved,
            hubAddress
        );
    }

    /**
     * @notice Cancel channel reservation (if channel open fails)
     * @param channelId Channel to cancel
     */
    function cancelReservation(
        bytes32 channelId
    ) external onlyHub validChannelReservation(channelId) {
        HubReservation memory reservation = channelReservations[channelId];

        totalETHReserved -= reservation.ethReserved;
        totalCKBReserved -= reservation.ckbReserved;

        delete channelReservations[channelId];
    }

    /**
     * @notice Redistribute funds back to pool after channel settlement
     * @param channelId Settled channel
     * @param ethReturned ETH returned from settlement
     * @param ckbReturned CKB returned from settlement
     * @param ethFees ETH fees earned from swaps
     * @param ckbFees CKB fees earned from swaps
     */
    function redistributeFromSettlement(
        bytes32 channelId,
        uint256 ethReturned,
        uint256 ckbReturned,
        uint256 ethFees,
        uint256 ckbFees
    ) external payable onlyHub validChannelReservation(channelId) nonReentrant {
        HubReservation memory reservation = channelReservations[channelId];

        // Verify hub sent back the ETH
        require(msg.value >= ethReturned, "Insufficient ETH returned");

        // Release reservation
        totalETHReserved -= reservation.ethReserved;
        totalCKBReserved -= reservation.ckbReserved;

        // Update pool liquidity (returned principal)
        poolState.totalETHLiquidity =
            poolState.totalETHLiquidity -
            reservation.ethReserved +
            ethReturned;
        poolState.totalCKBLiquidity =
            poolState.totalCKBLiquidity -
            reservation.ckbReserved +
            ckbReturned;

        // Accumulate fees for LP distribution
        poolState.accumulatedSwapFeeETH += ethFees;
        poolState.accumulatedSwapFeeCKB += ckbFees;
        poolState.lastUpdateTimestamp = block.timestamp;

        delete channelReservations[channelId];

        emit ChannelSettled(
            channelId,
            ethReturned,
            ckbReturned,
            ethFees,
            ckbFees
        );
        emit FeesDistributed(ethFees, ckbFees);
    }

    // ============ SWAP TRACKING (Off-chain verification) ============

    /**
     * @notice Record swap execution (called by hub for accounting)
     * @param swapId Unique swap identifier
     * @param channelId Channel where swap occurred
     * @param inputAmount Input asset amount
     * @param outputAmount Output asset amount
     * @param fee Fee collected
     * @param inputIsETH Direction of swap
     * @dev This is for record-keeping; actual swap happens off-chain
     */
    function recordSwap(
        bytes32 swapId,
        bytes32 channelId,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 fee,
        bool inputIsETH
    ) external onlyHub validChannelReservation(channelId) {
        require(!processedSwaps[swapId], "Swap already recorded");

        processedSwaps[swapId] = true;
        poolState.swapCount++;

        emit SwapExecuted(
            swapId,
            channelId,
            inputAmount,
            outputAmount,
            fee,
            inputIsETH
        );
    }

    // ============ FEE CLAIMING ============

    /**
     * @notice Claim accumulated fees for LP position
     */
    function claimFees()
        external
        nonReentrant
        returns (uint256 ethFees, uint256 ckbFees)
    {
        LPPosition storage position = lpPositions[msg.sender];
        require(position.active, "No active position");

        // Calculate claimable fees based on LP share
        (ethFees, ckbFees) = calculateClaimableFees(msg.sender);

        require(ethFees > 0 || ckbFees > 0, "No fees to claim");

        // Update position
        position.accumulatedFeesETH += ethFees;
        position.accumulatedFeesCKB += ckbFees;

        // Update pool state
        poolState.accumulatedSwapFeeETH -= ethFees;
        poolState.accumulatedSwapFeeCKB -= ckbFees;

        // Transfer ETH fees
        if (ethFees > 0) {
            _safeTransferETH(msg.sender, ethFees);
        }
        // CKB fees settled off-chain via Perun channel or direct transfer
    }

    /**
     * @notice Calculate claimable fees for an LP position
     * @param provider LP provider address
     * @return ethFees Claimable ETH fees
     * @return ckbFees Claimable CKB fees
     */
    function calculateClaimableFees(
        address provider
    ) public view returns (uint256 ethFees, uint256 ckbFees) {
        LPPosition memory position = lpPositions[provider];

        if (!position.active || poolState.totalLPShares <= 0) {
            return (0, 0);
        }

        ethFees =
            (poolState.accumulatedSwapFeeETH * position.lpShares) /
            poolState.totalLPShares;
        ckbFees =
            (poolState.accumulatedSwapFeeCKB * position.lpShares) /
            poolState.totalLPShares;
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Calculate swap output using constant product formula
     * @param inputAmount Input asset amount
     * @param inputIsETH True if input is ETH, false if CKB
     * @return outputAmount Output asset amount
     * @return fee Fee amount in input asset
     */
    function calculateSwapOutput(
        uint256 inputAmount,
        bool inputIsETH
    ) public view returns (uint256 outputAmount, uint256 fee) {
        (uint256 reserveIn, uint256 reserveOut) = inputIsETH
            ? (
                poolState.totalETHLiquidity - totalETHReserved,
                poolState.totalCKBLiquidity - totalCKBReserved
            )
            : (
                poolState.totalCKBLiquidity - totalCKBReserved,
                poolState.totalETHLiquidity - totalETHReserved
            );

        require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");

        // Calculate fee
        fee = (inputAmount * poolState.feeRateBasisPoints) / FEE_DENOMINATOR;
        uint256 inputWithFee = inputAmount - fee;

        // Constant product formula: x * y = k
        // output = (inputWithFee * reserveOut) / (reserveIn + inputWithFee)
        uint256 numerator = inputWithFee * reserveOut;
        uint256 denominator = reserveIn + inputWithFee;

        outputAmount = numerator / denominator;
        require(outputAmount < reserveOut, "Insufficient liquidity for swap");
    }

    function getPoolState() external view returns (PoolState memory) {
        return poolState;
    }

    function getLPPosition(
        address provider
    ) external view returns (LPPosition memory) {
        return lpPositions[provider];
    }

    function getChannelReservation(
        bytes32 channelId
    ) external view returns (HubReservation memory) {
        return channelReservations[channelId];
    }

    function getAvailableLiquidity()
        external
        view
        returns (uint256 ethAvailable, uint256 ckbAvailable)
    {
        ethAvailable = poolState.totalETHLiquidity - totalETHReserved;
        ckbAvailable = poolState.totalCKBLiquidity - totalCKBReserved;
    }

    // ============ ADMIN FUNCTIONS ============

    /**
     * @notice Update hub address
     * @param newHub New hub operator address
     */
    function updateHubAddress(address newHub) external onlyOwner {
        require(newHub != address(0), "Invalid hub address");
        address previousHub = hubAddress;
        hubAddress = newHub;
        emit HubUpdated(previousHub, newHub);
    }

    function updateFeeRate(uint16 newFeeRate) external onlyOwner {
        require(newFeeRate <= 1000, "Fee too high");
        poolState.feeRateBasisPoints = newFeeRate;
    }

    /**
     * @notice Emergency withdrawal (only owner, for exceptional circumstances)
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 availableETH = poolState.totalETHLiquidity - totalETHReserved;
        _safeTransferETH(owner(), availableETH);
    }

    // ============ HELPER FUNCTIONS ============

    /**
     * @notice Safe ETH transfer helper
     * @param to Recipient address
     * @param amount Amount of ETH to send
     */
    function _safeTransferETH(address to, uint256 amount) internal {
        Address.sendValue(payable(to), amount);
    }

    /**
     * @notice Square root function (Babylonian method)
     */
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    receive() external payable {
        // Allow hub to send ETH back during redistribution
        require(msg.sender == hubAddress, "Only hub can send ETH directly");
    }
}
