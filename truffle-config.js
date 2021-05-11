var PrivateKeyProvider = require("truffle-privatekey-provider");
// For deployment to a public network, enter your credentials here.
var GOERLI_NETWORK_URL = "";
var DEPLOYER_SECRET_KEY = "";
var ETHERSCAN_API_KEY = "";

module.exports = {
    api_keys: {
        etherscan: ETHERSCAN_API_KEY
    },

    networks: {
        development: {
            host: "127.0.0.1",
            port: 8545,
            network_id: "*",
        },
        goerli: {
            provider: () => new PrivateKeyProvider(
                DEPLOYER_SECRET_KEY,
                GOERLI_NETWORK_URL,
            ),
            network_id: 5,
        },
    },

    mocha: {
        reporter: 'eth-gas-reporter',
        reporterOptions: {
            // See https://www.npmjs.com/package/eth-gas-reporter
            // gasPrice: 300,
            onlyCalledMethods: false
        }
    },

    compilers: {
        solc: {
            version: "0.7.6",
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 200,
                },
            },
        }
    },

    plugins: ["solidity-coverage", "truffle-plugin-verify"],
}
