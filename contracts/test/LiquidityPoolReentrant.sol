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

import "../LiquidityPool.sol";

/// @dev Test fixture: an LP contract that re-enters LiquidityPool.withdraw
///      from its ETH receive hook. Used to prove the ReentrancyGuard holds.
contract LiquidityPoolReentrant {
    LiquidityPool public immutable pool;
    bool public attack;

    constructor(LiquidityPool _pool) {
        pool = _pool;
    }

    function depositToPool() external payable {
        pool.deposit{value: msg.value}();
    }

    function withdrawFromPool(uint256 shares, bool _attack) external {
        attack = _attack;
        pool.withdraw(shares);
    }

    receive() external payable {
        if (attack) {
            attack = false;
            pool.withdraw(1);
        }
    }
}

/// @dev Test fixture: force-sends ETH to a target via selfdestruct, bypassing
///      the target's receive() revert. Used for donation/inflation tests.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
