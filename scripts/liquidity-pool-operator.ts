import { ethers } from "hardhat";

async function main() {
    const action = process.env.ACTION;
    const poolAddress = process.env.POOL_ADDRESS;
    const signerIndex = Number(process.env.SIGNER_INDEX ?? "0");

    if (!action) {
        throw new Error("Missing ACTION env var");
    }
    if (!poolAddress) {
        throw new Error("Missing POOL_ADDRESS env var");
    }

    const signers = await ethers.getSigners();
    if (signerIndex < 0 || signerIndex >= signers.length) {
        throw new Error("SIGNER_INDEX out of range");
    }

    const signer = signers[signerIndex];
    const signerAddress = await signer.getAddress();
    const pool = await ethers.getContractAt("LiquidityPool", poolAddress, signer);

    if (action === "status") {
        const totalShares = await pool.totalShares();
        const totalLockedETH = await pool.totalLockedETH();
        const totalAssets = await pool.totalAssets();
        const withdrawableETH = await pool.withdrawableETH();
        const operator = await pool.operator();
        const user = process.env.USER_ADDRESS ?? signerAddress;
        const userShares = await pool.sharesOf(user);

        console.log("pool:", poolAddress);
        console.log("signer:", signerAddress);
        console.log("operator:", operator);
        console.log("totalShares:", totalShares.toString());
        console.log("totalLockedETH:", totalLockedETH.toString());
        console.log("totalAssets:", totalAssets.toString());
        console.log("withdrawableETH:", withdrawableETH.toString());
        console.log("user:", user);
        console.log("userShares:", userShares.toString());
        return;
    }

    if (action === "set-operator") {
        const newOperator = process.env.NEW_OPERATOR;
        if (!newOperator) {
            throw new Error("Missing NEW_OPERATOR env var");
        }

        const tx = await pool.setOperator(newOperator);
        await tx.wait();
        console.log("set-operator tx:", tx.hash);
        return;
    }

    if (action === "deposit") {
        const amountEth = process.env.AMOUNT_ETH;
        if (!amountEth) {
            throw new Error("Missing AMOUNT_ETH env var");
        }

        const tx = await pool.deposit({ value: ethers.parseEther(amountEth) });
        await tx.wait();
        console.log("deposit tx:", tx.hash);
        return;
    }

    if (action === "withdraw") {
        const sharesWei = process.env.SHARES_WEI;
        if (!sharesWei) {
            throw new Error("Missing SHARES_WEI env var");
        }

        const tx = await pool.withdraw(BigInt(sharesWei));
        await tx.wait();
        console.log("withdraw tx:", tx.hash);
        return;
    }

    if (action === "fund") {
        const channelId = process.env.CHANNEL_ID;
        const amountWei = process.env.AMOUNT_WEI;
        if (!channelId) {
            throw new Error("Missing CHANNEL_ID env var");
        }
        if (!amountWei) {
            throw new Error("Missing AMOUNT_WEI env var");
        }

        const tx = await pool.fundChannel(channelId, BigInt(amountWei));
        await tx.wait();
        console.log("fund tx:", tx.hash);
        return;
    }

    if (action === "settle") {
        const channelId = process.env.CHANNEL_ID;
        const returnWei = process.env.RETURN_WEI;
        if (!channelId) {
            throw new Error("Missing CHANNEL_ID env var");
        }
        if (!returnWei) {
            throw new Error("Missing RETURN_WEI env var");
        }

        const tx = await pool.settleChannel(channelId, { value: BigInt(returnWei) });
        await tx.wait();
        console.log("settle tx:", tx.hash);
        return;
    }

    throw new Error(`Unsupported ACTION: ${action}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
