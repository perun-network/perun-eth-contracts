async function deploy(contractsFileName) {
    const accounts = await ethers.getSigners();
    let accAddresses = [];
    // Deployment fails if too many addresses are given as parameters.
    accAddresses[0] = accounts[0].address; // Prefund Alice.
    accAddresses[1] = accounts[1].address; // Prefund Bob.

    const deployerAddress = (await getNamedAccounts()).deployer;
    const deployer = await ethers.getSigner(deployerAddress);
    let nonce = await deployer.getTransactionCount();

    const ChannelFactory = await ethers.getContractFactory("Channel", deployer);
    const AdjudicatorFactory = await ethers.getContractFactory("Adjudicator", deployer);
    const AssetHolderETHFactory = await ethers.getContractFactory("AssetHolderETH", deployer);
    const AssetHolderERC20Factory = await ethers.getContractFactory("AssetHolderERC20", deployer);
    const PerunTokenFactory = await ethers.getContractFactory("PerunToken", deployer);

    let deployedContracts = {
        "assets": {
            "ETH": {
                "type": "eth"
            },
            "PerunToken": {
                "type": "erc20"
            }
        }
    };

    const channel = await ChannelFactory.deploy(overrides = {nonce: nonce++});
    console.log("Channel deployed to address:", channel.address);
    deployedContracts.channel = channel.address;

    const adjudicator = await AdjudicatorFactory.deploy(overrides = {nonce: nonce++});
    console.log("Adjudicator deployed to address:", adjudicator.address);
    deployedContracts.adjudicator = adjudicator.address;

    const assetholderETH = await AssetHolderETHFactory.deploy(adjudicator.address, overrides = {nonce: nonce++});
    console.log("AssetHolderETH deployed to address:", assetholderETH.address);
    deployedContracts.assets.ETH.assetholder = assetholderETH.address;

    const perunToken = await PerunTokenFactory.deploy(accAddresses, "1000000000000000000000", overrides = {nonce: nonce++});
    console.log("PerunToken deployed to address:", perunToken.address);
    deployedContracts.assets.PerunToken.address = perunToken.address;

    const assetholderERC20 = await AssetHolderERC20Factory.deploy(adjudicator.address, perunToken.address, overrides = {nonce: nonce++});
    console.log("AssetHolderERC20 deployed to address:", assetholderERC20.address);
    deployedContracts.assets.PerunToken.assetholder = assetholderERC20.address;


    const fs = require('fs');
    if (!contractsFileName.endsWith('.json')) {
        contractsFileName = contractsFileName.concat('.json');
    }
    fs.writeFileSync(contractsFileName, JSON.stringify(deployedContracts, null, "\t"));
}


module.exports = {deploy}