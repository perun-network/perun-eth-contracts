require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-waffle')
require('@eth-optimism/hardhat-ovm')
require("@nomiclabs/hardhat-truffle5");
require('hardhat-deploy')

task("accounts", "Prints the list of accounts", async () => {
    const accounts = await ethers.getSigners();

    console.log(accounts.length);
  
    for (const account of accounts) {
      console.log(account.address);
    }
  });

module.exports = {
  networks: {
    hardhat: {
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      }
    },
    optimism: {
      url: 'https://kovan.optimism.io',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
      // This sets the gas price to 0 for all transactions on L2. We do this
      // because account balances are not automatically initiated with an ETH
      // balance (yet, sorry!).
      gasPrice: 0,
      ovm: true // This sets the network as using the ovm and ensure contract will be compiled against that.
    }
  },
  solidity: '0.7.6',
  ovm: {
    solcVersion: '0.7.6'
  },
  namedAccounts: {
    deployer: 0
  },
}