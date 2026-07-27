<h1 align="center"><br>
  <a href="https://perun.network/"><img src=".assets/logo.png" alt="Perun" width="196"></a>
<br></h1>

<h4 align="center">Perun State Channels Framework - Ethereum Backend Smart Contracts</h4>

<p align="center">
  <a href="https://codecov.io/gh/hyperledger-labs/perun-eth-contracts"><img src="https://codecov.io/gh/hyperledger-labs/perun-eth-contracts/branch/main/graph/badge.svg?token=QXZH8MKQG5" alt="Codecov"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0.txt"><img src="https://img.shields.io/badge/license-Apache%202-blue" alt="License: Apache 2.0"></a>
  <a href="https://github.com/hyperledger-labs/perun-eth-contracts/actions/workflows/ci.yml"><img src="https://github.com/hyperledger-labs/perun-eth-contracts/actions/workflows/ci.yml/badge.svg" alt="Pipeline status"></a>
</p>

This repository contains the Ethereum smart contracts for [go-perun](https://github.com/hyperledger-labs/go-perun)'s Ethereum backend.
Additionally, it allows cross-chain swaps with the Stellar blockchain. It supports our [Soroban Contract](https://github.com/perun-network/perun-soroban-contract), utilizing EVM-compatible cryptography and encoding. Channel participants can have multiple addresses in the channel.

## Security Disclaimer
The smart contracts presented in this directory are under active development and are not ready for production use.
The authors take no responsibility for any loss of digital assets or other damage caused by their use.

## Contracts
Perun's Generalized State Channels Framework uses a set of interconnected smart contracts to define the on-chain logic for channel deposits, disputes, settlements and withdrawals.
For more detailed information, check out the [documentation](https://labs.hyperledger.org/perun-doc/index.html).

### Asset Holder
Asset holders are singleton contracts that hold the assets for ledger channels.
They are deployed once per asset (ETH, ERC-20, ...) and are shared between all channels that reference the same Adjudicator contract for channel disputing and closing.

Deposits are directly transferred to the Asset Holders.
The outcome of closed channels are set by the Adjudicator on the channel's asset holders.
After the outcome has been set, channel participants can withdraw their assets from the asset holders, sending a Withdrawal Authorization that has to be signed by the respective channel participant.

### Adjudicator
The Adjudicator contract is called to dispute or close a channel.
It interprets channel states and sets finalized channel outcomes on the asset holders.

**Collaborative Close**&emsp;
All channel participants can agree on a final state off-chain.
In this case they can settle a channel without waiting for any timeouts by calling `concludeFinal` on the Adjudicator.
The Adjudicator will set the outcome on the individual asset holders, ready for withdrawal.

**Dispute**&emsp;
In case of a channel dispute, any party can `register` their final state on the Adjudicator contract.
After state registration, the other channel participants have the chance to `refute` the submitted state with a higher-version state during the challenge period.
After the challenge period is over, the channel outcome can either be finalized on the asset holders by calling `conclude` or the app's state can be progressed on-chain by calling `progress`.

### App Contracts
State Channel apps define a single method, `validTransition`, which defines the app-specific state transition rules.
When a channel state is progressed on-chain on the Adjudicator by calling `progress`, the Adjudicator reads the address of the channel app from the channel parameters and, after performing generic state progression checks, calls the `validTransition` method on the app.
It is assumed to revert if any app-specific check fails.

## ETH Liquidity Pool MVP
The repository includes an ETH-only liquidity pool MVP for Perun-X yield in `contracts/LiquidityPool.sol`.

### Contract model
- LPs deposit ETH and receive shares.
- LPs withdraw by burning shares against withdrawable ETH.
- A trusted operator funds channels and settles them back into the pool.
- Settlement is payable and channel-specific.
- Settlement below recorded principal is rejected.
- Fee yield accrues implicitly as ETH backing per share increases when settlement returns above principal.

### Deployment
Build contracts first:
```sh
$ yarn
$ yarn build
```

Local devnet deployment using Hardhat Ignition:
```sh
$ npx hardhat ignition deploy ignition/modules/LiquidityPool.ts --network localhost --parameters ignition/parameters/localhost/liquidity-pool.json
```

Sepolia deployment (after replacing the placeholder operator address):
```sh
$ npx hardhat ignition deploy ignition/modules/LiquidityPool.ts --network sepolia --parameters ignition/parameters/sepolia/liquidity-pool.json
```

Migration compatibility path:
```sh
$ npx hardhat run migrations/2_deploy_contracts.js --network localhost
```

### Operator and LP flow
1. Owner deploys the pool with initial operator.
2. Owner rotates operator with `setOperator` if needed.
3. LPs call `deposit` with ETH to mint shares.
4. Operator calls `fundChannel(channelId, amount)` to lock principal per channel and transfer funding ETH to operator custody for channel use.
5. Operator calls `settleChannel(channelId)` with `msg.value` set to returned ETH after channel settlement.
6. LPs call `withdraw(shares)` to burn shares and receive ETH from withdrawable liquidity.

### Hub integration assumptions (MVP)
- Pricing, quote generation, and swap matching remain off-chain in the Hub.
- The Hub/operator is responsible for passing a stable channel identifier to `fundChannel` and `settleChannel`.
- The Hub/operator must ensure settlement calls return at least channel principal (`msg.value >= locked principal`).
- This contract intentionally does not implement decentralized operator governance, oracle controls, or production monitoring in MVP.

### Operator helper script
For manual dev/test operations, use `scripts/liquidity-pool-operator.ts`.

Status and balances:
```sh
$ ACTION=status POOL_ADDRESS=0xPOOL npx hardhat run scripts/liquidity-pool-operator.ts --network localhost
```

Deposit 1 ETH from signer index 1:
```sh
$ ACTION=deposit POOL_ADDRESS=0xPOOL SIGNER_INDEX=1 AMOUNT_ETH=1 npx hardhat run scripts/liquidity-pool-operator.ts --network localhost
```

Fund channel (operator signer):
```sh
$ ACTION=fund POOL_ADDRESS=0xPOOL SIGNER_INDEX=0 CHANNEL_ID=0xCHANNEL_ID AMOUNT_WEI=1000000000000000000 npx hardhat run scripts/liquidity-pool-operator.ts --network localhost
```

Settle channel with returned ETH:
```sh
$ ACTION=settle POOL_ADDRESS=0xPOOL SIGNER_INDEX=0 CHANNEL_ID=0xCHANNEL_ID RETURN_WEI=1100000000000000000 npx hardhat run scripts/liquidity-pool-operator.ts --network localhost
```

Withdraw shares:
```sh
$ ACTION=withdraw POOL_ADDRESS=0xPOOL SIGNER_INDEX=1 SHARES_WEI=1000000000000000000 npx hardhat run scripts/liquidity-pool-operator.ts --network localhost
```

## Testing
The repository must be cloned recursively including [submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules).
[Yarn](https://yarnpkg.com) and [Hardhat](https://hardhat.org/hardhat-runner/docs/getting-started) are expected to be installed globally.
To run the tests, run
```sh
$ yarn
$ yarn build
$ yarn test
```

## Copyright
Copyright 2025 - See [NOTICE](NOTICE) file for copyright holders.
Use of the source code is governed by the Apache 2.0 license that can be found in the [LICENSE file](LICENSE).

Contact us at [info@perun.network](mailto:info@perun.network).
