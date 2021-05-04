async function main() {
    const accounts = await ethers.getSigners();
    let accAddresses = [];
    // Deployment fails if too many addresses are given as parameters.
    accAddresses[0] = accounts[0].address; // Prefund Alice.
    accAddresses[1] = accounts[1].address; // Prefund Bob.

    const ChannelFactory = await ethers.getContractFactory("Channel");
    const AdjudicatorFactory = await ethers.getContractFactory("Adjudicator",);
    const AssetHolderETHFactory = await ethers.getContractFactory("AssetHolderETH");
    const AssetHolderERC20Factory = await ethers.getContractFactory("AssetHolderERC20");
    const PerunTokenFactory = await ethers.getContractFactory("PerunToken");

    let deployedContracts = {};

    const channel = await ChannelFactory.deploy(); 
    console.log("Channel deployed to address:", channel.address);
    deployedContracts.channel = channel.address;

    const adjudicator = await AdjudicatorFactory.deploy();
    console.log("Adjudicator deployed to address:", adjudicator.address);
    deployedContracts.adjudicator = adjudicator.address;

    const assetholderETH = await AssetHolderETHFactory.deploy(adjudicator.address);
    console.log("AssetHolderETH deployed to address:", assetholderETH.address);
    deployedContracts.assetholderETH = assetholderETH.address;

    const perunToken = await PerunTokenFactory.deploy(accAddresses, "1000000000000000000000");
    console.log("PerunToken deployed to address:", perunToken.address);
    deployedContracts.perunToken = perunToken.address;

    const assetholderERC20 = await AssetHolderERC20Factory.deploy(adjudicator.address, perunToken.address);
    console.log("AssetHolderERC20 deployed to address:", assetholderERC20.address);
    deployedContracts.assetholderERC20 = assetholderERC20.address;


    const fs = require('fs');
    let deployedContractsJSON = JSON.stringify(deployedContracts);
    fs.writeFileSync('deployed-contracts.json', deployedContractsJSON);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
