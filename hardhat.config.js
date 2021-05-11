require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-waffle')
require('@eth-optimism/hardhat-ovm')
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-etherscan");
require('hardhat-deploy')

task("accounts", "Prints the list of accounts", async () => {
    const accounts = await ethers.getSigners();

    console.log(accounts.length);
  
    for (const account of accounts) {
      console.log(account.address);
    }
  });

module.exports = {
  etherscan: {
    apiKey: "<fill in with your etherscan api key>"
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      }
    },

    goerli: {
      url: '<fill in with your infura gröli config>',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
    },

    optimism_local: {
      url: 'http://127.0.0.1:8545',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
      gasPrice: 0,
      ovm: true
    },

    optimism_kovan: {
      url: 'https://kovan.optimism.io',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
      gasPrice: 0,
      ovm: true
    },

    arbitrum_local: {
      url: 'http://127.0.0.1:8547',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
      gasPrice: 0
    },

    arbitrum_kovan: {
      url: 'https://kovan4.arbitrum.io/rpc',
      accounts: {
        mnemonic: 'pistol kiwi shrug future ozone ostrich match remove crucial oblige cream critic'
      },
      gasPrice: 0
    }
  },

  solidity: {
    version: "0.7.4",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  namedAccounts: {
    deployer: 0
  },
}
