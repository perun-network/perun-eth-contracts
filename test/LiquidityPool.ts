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

import { expect } from "chai";
import { ethers } from "hardhat";
import { LiquidityPool } from "../typechain-types/contracts/LiquidityPool";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

function cid(name: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(name));
}

describe("LiquidityPool", function () {
    let owner: SignerWithAddress;
    let operator: SignerWithAddress;
    let lp1: SignerWithAddress;
    let lp2: SignerWithAddress;
    let other: SignerWithAddress;
    let pool: LiquidityPool;

    beforeEach(async () => {
        [owner, operator, lp1, lp2, other] = await ethers.getSigners();
        const factory = await ethers.getContractFactory("LiquidityPool");
        pool = await factory.connect(owner).deploy(await operator.getAddress());
        await pool.waitForDeployment();
    });

    describe("deposit", () => {
        it("mints 1:1 shares for first LP", async () => {
            const amount = ethers.parseEther("10");
            await pool.connect(lp1).deposit({ value: amount });

            expect(await pool.totalShares()).to.equal(amount);
            expect(await pool.sharesOf(await lp1.getAddress())).to.equal(amount);
        });

        it("mints proportional shares for later LPs", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });

            const amount2 = ethers.parseEther("5");
            expect(await pool.previewDepositShares(amount2)).to.equal(amount2);

            await pool.connect(lp2).deposit({ value: amount2 });

            expect(await pool.sharesOf(await lp2.getAddress())).to.equal(amount2);
            expect(await pool.totalShares()).to.equal(ethers.parseEther("15"));
        });

        it("rejects zero deposit", async () => {
            await expect(pool.connect(lp1).deposit({ value: 0n })).to.be.revertedWith(
                "Deposit must be > 0"
            );
        });

        it("rejects deposit that rounds minted shares to zero", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("1") });

            const channelId = cid("rounding-mint");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"));
            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("2") });

            await expect(pool.connect(lp2).deposit({ value: 1n })).to.be.revertedWith(
                "Minted shares = 0"
            );
        });
    });

    describe("withdraw", () => {
        it("supports partial withdrawal", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });

            const burn = ethers.parseEther("4");
            const expectedOut = await pool.connect(lp1).withdraw.staticCall(burn);

            const poolAddress = await pool.getAddress();
            const balBefore = await ethers.provider.getBalance(poolAddress);

            await pool.connect(lp1).withdraw(burn);

            const balAfter = await ethers.provider.getBalance(poolAddress);
            expect(balBefore - balAfter).to.equal(expectedOut);
            expect(await pool.sharesOf(await lp1.getAddress())).to.equal(
                ethers.parseEther("6")
            );
            expect(await pool.totalShares()).to.equal(ethers.parseEther("6"));
        });

        it("supports full withdrawal", async () => {
            const amount = ethers.parseEther("7");
            await pool.connect(lp1).deposit({ value: amount });

            await pool.connect(lp1).withdraw(amount);

            expect(await pool.sharesOf(await lp1.getAddress())).to.equal(0n);
            expect(await pool.totalShares()).to.equal(0n);
        });

        it("rejects insufficient shares", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("1") });

            await expect(
                pool.connect(lp1).withdraw(ethers.parseEther("2"))
            ).to.be.revertedWith("Insufficient shares");
        });

        it("excludes actively locked liquidity from withdrawal", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });

            const channelId = cid("locked-withdraw");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("8"));

            expect(await pool.totalLockedETH()).to.equal(ethers.parseEther("8"));
            expect(await pool.withdrawableETH()).to.equal(ethers.parseEther("2"));

            const allShares = await pool.sharesOf(await lp1.getAddress());
            const out = await pool.connect(lp1).withdraw.staticCall(allShares);
            expect(out).to.equal(ethers.parseEther("2"));

            await pool.connect(lp1).withdraw(allShares);
            expect(await pool.totalShares()).to.equal(0n);
            expect(await pool.totalLockedETH()).to.equal(ethers.parseEther("8"));
        });

        it("rejects withdraw that rounds to zero", async () => {
            await pool.connect(lp1).deposit({ value: 1n });
            await pool.connect(lp2).deposit({ value: ethers.parseEther("1") });
            await pool
                .connect(operator)
                .fundChannel(cid("withdraw-rounding"), ethers.parseEther("1"));

            await expect(pool.connect(lp1).withdraw(1n)).to.be.revertedWith(
                "Withdraw amount = 0"
            );
        });
    });

    describe("funding", () => {
        it("is operator-only", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            await expect(
                pool.connect(other).fundChannel(cid("op-only"), ethers.parseEther("1"))
            ).to.be.revertedWith("Only operator can call");
        });

        it("rejects duplicate active channel funding", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("3") });
            const channelId = cid("dup");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"));

            await expect(
                pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"))
            ).to.be.revertedWith("Channel already funded");
        });

        it("rejects insufficient free liquidity", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });

            await expect(
                pool.connect(operator).fundChannel(cid("liq"), ethers.parseEther("3"))
            ).to.be.revertedWith("Insufficient free liquidity");
        });

        it("supports multiple active channels with consistent aggregate lock", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("20") });

            const c1 = cid("multi-1");
            const c2 = cid("multi-2");
            await pool.connect(operator).fundChannel(c1, ethers.parseEther("6"));
            await pool.connect(operator).fundChannel(c2, ethers.parseEther("4"));

            expect(await pool.lockedByChannel(c1)).to.equal(ethers.parseEther("6"));
            expect(await pool.lockedByChannel(c2)).to.equal(ethers.parseEther("4"));
            expect(await pool.totalLockedETH()).to.equal(ethers.parseEther("10"));
            expect(await pool.withdrawableETH()).to.equal(ethers.parseEther("10"));
        });
    });

    describe("settlement", () => {
        it("is operator-only", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            const channelId = cid("settle-op-only");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"));

            await expect(
                pool.connect(other).settleChannel(channelId, { value: ethers.parseEther("1") })
            ).to.be.revertedWith("Only operator can call");
        });

        it("rejects unknown channel", async () => {
            await expect(
                pool.connect(operator).settleChannel(cid("unknown"), { value: 1n })
            ).to.be.revertedWith("Unknown channel");
        });

        it("rejects settlement below principal", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("5") });
            const channelId = cid("under-return");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("5"));

            await expect(
                pool
                    .connect(operator)
                    .settleChannel(channelId, { value: ethers.parseEther("4.999") })
            ).to.be.revertedWith("Returned ETH below principal");
        });

        it("supports exact-principal settlement", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("5") });
            const channelId = cid("exact-principal");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("5"));

            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("5") });

            expect(await pool.lockedByChannel(channelId)).to.equal(0n);
            expect(await pool.totalLockedETH()).to.equal(0n);
        });

        it("keeps fee-bearing settlement surplus in pool and raises share value", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            const channelId = cid("fee-bearing");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("8"));

            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("10") });

            // With 10 shares outstanding and 12 ETH withdrawable, next 12 ETH deposit
            // should mint 10 shares due to increased backing per share.
            const mintPreview = await pool.previewDepositShares(ethers.parseEther("12"));
            expect(mintPreview).to.equal(ethers.parseEther("10"));
        });

        it("is order-independent across multiple channels", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("20") });

            const c1 = cid("order-1");
            const c2 = cid("order-2");

            await pool.connect(operator).fundChannel(c1, ethers.parseEther("6"));
            await pool.connect(operator).fundChannel(c2, ethers.parseEther("4"));

            await pool
                .connect(operator)
                .settleChannel(c2, { value: ethers.parseEther("5") });
            expect(await pool.totalLockedETH()).to.equal(ethers.parseEther("6"));

            await pool
                .connect(operator)
                .settleChannel(c1, { value: ethers.parseEther("7") });
            expect(await pool.totalLockedETH()).to.equal(0n);

            // Initial assets 20 + 2 fee gain = 22.
            expect(await pool.totalAssets()).to.equal(ethers.parseEther("22"));
        });
    });

    describe("end-to-end", () => {
        it("deposit -> fund -> settle -> withdraw path", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });

            const channelId = cid("e2e");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("8"));
            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("9") });

            const allShares = await pool.sharesOf(await lp1.getAddress());
            const out = await pool.connect(lp1).withdraw.staticCall(allShares);
            expect(out).to.equal(ethers.parseEther("11"));

            await pool.connect(lp1).withdraw(allShares);
            expect(await pool.totalShares()).to.equal(0n);
            expect(await pool.totalLockedETH()).to.equal(0n);
            expect(await pool.totalAssets()).to.equal(0n);
        });
    });
});
