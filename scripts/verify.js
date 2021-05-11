async function main() {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('deployed-contracts.json'));
    const accounts = await ethers.getSigners();
    let accAddresses = [accounts[0].address, accounts[1].address];

    let contracts = [{
        address: cfg.channel,
        contract: "contracts/Channel.sol:Channel"
    },
    {
        address: cfg.adjudicator,
        contract: "contracts/Adjudicator.sol:Adjudicator"
    },
    {
        address: cfg.assets.ETH.assetholder,
        contract: "contracts/AssetHolderETH.sol:AssetHolderETH",
        constructorArguments: [cfg.adjudicator]
    },
    {
        address: cfg.assets.PerunToken.address,
        contract: "contracts/PerunToken.sol:PerunToken",
        constructorArguments: [accAddresses, "1000000000000000000000"]
    },
    {
        address: cfg.assets.PerunToken.assetholder,
        contract: "contracts/AssetHolderERC20.sol:AssetHolderERC20",
        constructorArguments: [cfg.adjudicator, cfg.assets.PerunToken.address]
    }]

    for (let contract of contracts)
        await verify(contract);
}

async function verify(args) {
    console.log("Verifying: ", args.contract);
    try {
        await hre.run("verify:verify", args);
    } catch (e) {
        if (e.message == "Contract source code already verified") {
            console.log("Already verified: ", args.contract);
            return;
        }
        else
            throw e;
    }
    console.log("Verified: ", args.contract);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
