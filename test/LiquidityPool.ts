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
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { LiquidityPool } from "../typechain-types/contracts/LiquidityPool";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

function cid(name: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const SETTLEMENT_WINDOW = 3600n;
const MIN_FEE_BPS = 10n; // 0.1%
const BPS = 10000n;

function withFeeFloor(principal: bigint): bigint {
    return principal + (principal * MIN_FEE_BPS) / BPS;
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
        pool = await factory
            .connect(owner)
            .deploy(await operator.getAddress(), SETTLEMENT_WINDOW, MIN_FEE_BPS);
        await pool.waitForDeployment();
    });

    async function bond(amount: bigint) {
        await pool.connect(operator).bondETH({ value: amount });
    }

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
            await bond(ethers.parseEther("1"));

            const channelId = cid("rounding-mint");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"));
            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("2") });

            await expect(pool.connect(lp2).deposit({ value: 1n })).to.be.revertedWith(
                "Minted shares = 0"
            );
        });

        it("prices deposits on LP assets, ignoring the operator bond", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("50"));

            // Bond must not dilute: 5 ETH still mints 5 shares.
            const amount2 = ethers.parseEther("5");
            expect(await pool.previewDepositShares(amount2)).to.equal(amount2);
            await pool.connect(lp2).deposit({ value: amount2 });
            expect(await pool.sharesOf(await lp2.getAddress())).to.equal(amount2);
        });
    });

    describe("depositFor", () => {
        it("mints the shares to the beneficiary, not the caller", async () => {
            const amount = ethers.parseEther("10");
            await pool
                .connect(operator)
                .depositFor(await lp1.getAddress(), { value: amount });

            expect(await pool.sharesOf(await lp1.getAddress())).to.equal(amount);
            expect(await pool.sharesOf(await operator.getAddress())).to.equal(0n);
            expect(await pool.totalShares()).to.equal(amount);
        });

        it("prices identically to deposit", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });

            const amount2 = ethers.parseEther("5");
            expect(await pool.previewDepositShares(amount2)).to.equal(amount2);

            await pool
                .connect(operator)
                .depositFor(await lp2.getAddress(), { value: amount2 });

            expect(await pool.sharesOf(await lp2.getAddress())).to.equal(amount2);
            expect(await pool.totalShares()).to.equal(ethers.parseEther("15"));
        });

        it("emits Deposited crediting the beneficiary", async () => {
            const amount = ethers.parseEther("3");
            await expect(
                pool
                    .connect(operator)
                    .depositFor(await lp1.getAddress(), { value: amount })
            )
                .to.emit(pool, "Deposited")
                .withArgs(await lp1.getAddress(), amount, amount);
        });

        it("rejects the zero beneficiary", async () => {
            await expect(
                pool
                    .connect(operator)
                    .depositFor(ethers.ZeroAddress, { value: ethers.parseEther("1") })
            ).to.be.revertedWith("Invalid beneficiary");
        });

        it("rejects zero value", async () => {
            await expect(
                pool.connect(operator).depositFor(await lp1.getAddress(), { value: 0n })
            ).to.be.revertedWith("Deposit must be > 0");
        });

        it("lets the beneficiary withdraw the credited ETH", async () => {
            const amount = ethers.parseEther("4");
            await pool
                .connect(operator)
                .depositFor(await lp1.getAddress(), { value: amount });

            const shares = await pool.sharesOf(await lp1.getAddress());
            const before = await ethers.provider.getBalance(await lp1.getAddress());
            const tx = await pool.connect(lp1).withdraw(shares);
            const receipt = await tx.wait();
            const gas = receipt!.gasUsed * receipt!.gasPrice;
            const after = await ethers.provider.getBalance(await lp1.getAddress());

            expect(after - before + gas).to.equal(amount);
            expect(await pool.sharesOf(await lp1.getAddress())).to.equal(0n);
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

        it("redeems at the totalAssets price while principal is locked", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("20"));
            await pool
                .connect(operator)
                .fundChannel(cid("locked-price"), ethers.parseEther("8"));

            // 10% of shares is worth 1 ETH of the 10 ETH totalAssets, and the
            // 2 ETH free liquidity covers it. The pre-fix contract would have
            // paid only 0.2 ETH (free-balance pricing).
            const burn = ethers.parseEther("1");
            const out = await pool.connect(lp1).withdraw.staticCall(burn);
            expect(out).to.equal(ethers.parseEther("1"));

            await pool.connect(lp1).withdraw(burn);
            expect(await pool.totalShares()).to.equal(ethers.parseEther("9"));
        });

        it("rejects withdrawal beyond free liquidity", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("20"));
            await pool
                .connect(operator)
                .fundChannel(cid("free-cap"), ethers.parseEther("8"));

            // 30% of shares is worth 3 ETH but only 2 ETH is free.
            await expect(
                pool.connect(lp1).withdraw(ethers.parseEther("3"))
            ).to.be.revertedWith("Insufficient free liquidity");
        });

        it("pays dust for a 1-share withdrawal instead of rounding to zero", async () => {
            await pool.connect(lp1).deposit({ value: 1n });
            await pool.connect(lp2).deposit({ value: ethers.parseEther("1") });
            await bond(ethers.parseEther("1"));
            await pool
                .connect(operator)
                .fundChannel(cid("withdraw-rounding"), ethers.parseEther("1"));

            // Share price never drops below 1:1 (deposits round mints down,
            // settlements only add assets), so 1 share redeems to exactly
            // 1 wei here; the "Withdraw amount = 0" guard is defense-in-depth.
            const out = await pool.connect(lp1).withdraw.staticCall(1n);
            expect(out).to.equal(1n);
            await pool.connect(lp1).withdraw(1n);
        });

        it("never pays out the operator bond", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            await bond(ethers.parseEther("100"));

            const allShares = await pool.sharesOf(await lp1.getAddress());
            const out = await pool.connect(lp1).withdraw.staticCall(allShares);
            expect(out).to.equal(ethers.parseEther("2"));

            await pool.connect(lp1).withdraw(allShares);
            expect(await pool.operatorBond()).to.equal(ethers.parseEther("100"));
        });
    });

    describe("bond", () => {
        it("bondETH is operator-only and must be > 0", async () => {
            await expect(
                pool.connect(other).bondETH({ value: 1n })
            ).to.be.revertedWith("Only operator can call");
            await expect(
                pool.connect(operator).bondETH({ value: 0n })
            ).to.be.revertedWith("Bond must be > 0");
        });

        it("is excluded from totalAssets and withdrawableETH", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("20"));

            expect(await pool.totalAssets()).to.equal(ethers.parseEther("10"));
            expect(await pool.withdrawableETH()).to.equal(ethers.parseEther("10"));
            expect(await pool.operatorBond()).to.equal(ethers.parseEther("20"));
        });

        it("withdrawBond pays the operator down to the coverage floor", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("20"));
            await pool
                .connect(operator)
                .fundChannel(cid("bond-coverage"), ethers.parseEther("8"));

            await expect(
                pool.connect(operator).withdrawBond(ethers.parseEther("13"))
            ).to.be.revertedWith("Bond below coverage");

            const opAddr = await operator.getAddress();
            const before = await ethers.provider.getBalance(opAddr);
            const tx = await pool
                .connect(operator)
                .withdrawBond(ethers.parseEther("12"));
            const receipt = await tx.wait();
            const gas = receipt!.gasUsed * receipt!.gasPrice;
            const after = await ethers.provider.getBalance(opAddr);

            expect(after - before + gas).to.equal(ethers.parseEther("12"));
            expect(await pool.operatorBond()).to.equal(ethers.parseEther("8"));
        });

        it("withdrawBond rejects non-operator and amounts above the bond", async () => {
            await bond(ethers.parseEther("1"));
            await expect(
                pool.connect(other).withdrawBond(1n)
            ).to.be.revertedWith("Only operator can call");
            await expect(
                pool.connect(operator).withdrawBond(ethers.parseEther("2"))
            ).to.be.revertedWith("Insufficient bond");
        });
    });

    describe("funding", () => {
        it("is operator-only", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            await bond(ethers.parseEther("2"));
            await expect(
                pool.connect(other).fundChannel(cid("op-only"), ethers.parseEther("1"))
            ).to.be.revertedWith("Only operator can call");
        });

        it("rejects duplicate active channel funding", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("3") });
            await bond(ethers.parseEther("3"));
            const channelId = cid("dup");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"));

            await expect(
                pool.connect(operator).fundChannel(channelId, ethers.parseEther("1"))
            ).to.be.revertedWith("Channel already funded");
        });

        it("rejects insufficient free liquidity", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            await bond(ethers.parseEther("10"));

            await expect(
                pool.connect(operator).fundChannel(cid("liq"), ethers.parseEther("3"))
            ).to.be.revertedWith("Insufficient free liquidity");
        });

        it("rejects funding not covered by the bond", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("5"));
            await pool
                .connect(operator)
                .fundChannel(cid("covered"), ethers.parseEther("3"));

            // 3 locked + 3 requested = 6 > 5 bonded.
            await expect(
                pool.connect(operator).fundChannel(cid("uncovered"), ethers.parseEther("3"))
            ).to.be.revertedWith("Insufficient bond coverage");
        });

        it("sets the settlement deadline", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });
            await bond(ethers.parseEther("2"));

            const channelId = cid("deadline");
            const tx = await pool
                .connect(operator)
                .fundChannel(channelId, ethers.parseEther("1"));
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt!.blockNumber);

            expect(await pool.channelDeadline(channelId)).to.equal(
                BigInt(block!.timestamp) + SETTLEMENT_WINDOW
            );
        });

        it("supports multiple active channels with consistent aggregate lock", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("20") });
            await bond(ethers.parseEther("20"));

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
            await bond(ethers.parseEther("2"));
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

        it("rejects settlement below the principal-plus-fee floor", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("5") });
            await bond(ethers.parseEther("5"));
            const channelId = cid("under-return");
            const principal = ethers.parseEther("5");
            await pool.connect(operator).fundChannel(channelId, principal);

            // Exact principal no longer clears: the fee floor is enforced.
            await expect(
                pool.connect(operator).settleChannel(channelId, { value: principal })
            ).to.be.revertedWith("Returned ETH below principal plus fee floor");
            await expect(
                pool
                    .connect(operator)
                    .settleChannel(channelId, { value: withFeeFloor(principal) - 1n })
            ).to.be.revertedWith("Returned ETH below principal plus fee floor");
        });

        it("accepts exactly the minSettlementValue", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("5") });
            await bond(ethers.parseEther("5"));
            const channelId = cid("exact-floor");
            const principal = ethers.parseEther("5");
            await pool.connect(operator).fundChannel(channelId, principal);

            const minValue = await pool.minSettlementValue(channelId);
            expect(minValue).to.equal(withFeeFloor(principal));

            await pool.connect(operator).settleChannel(channelId, { value: minValue });

            expect(await pool.lockedByChannel(channelId)).to.equal(0n);
            expect(await pool.channelDeadline(channelId)).to.equal(0n);
            expect(await pool.totalLockedETH()).to.equal(0n);
        });

        it("keeps fee-bearing settlement surplus in pool and raises share value", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("10"));
            const channelId = cid("fee-bearing");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("8"));

            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("10") });

            // With 10 shares outstanding and 12 ETH of assets, the next 12 ETH
            // deposit mints 10 shares due to increased backing per share.
            const mintPreview = await pool.previewDepositShares(ethers.parseEther("12"));
            expect(mintPreview).to.equal(ethers.parseEther("10"));
        });

        it("is order-independent across multiple channels", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("20") });
            await bond(ethers.parseEther("20"));

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

    describe("expiry", () => {
        const principal = ethers.parseEther("8");
        let channelId: string;

        beforeEach(async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("20"));
            channelId = cid("expiry");
            await pool.connect(operator).fundChannel(channelId, principal);
        });

        it("rejects expiry before the deadline", async () => {
            await expect(pool.connect(other).expireChannel(channelId)).to.be.revertedWith(
                "Not expired"
            );
        });

        it("rejects unknown channel", async () => {
            await expect(
                pool.connect(other).expireChannel(cid("never-funded"))
            ).to.be.revertedWith("Unknown channel");
        });

        it("lets anyone slash the bond after the deadline, leaving LP assets whole", async () => {
            const assetsBefore = await pool.totalAssets();

            await time.increase(Number(SETTLEMENT_WINDOW) + 1);
            await expect(pool.connect(other).expireChannel(channelId))
                .to.emit(pool, "ChannelExpired")
                .withArgs(channelId, principal, await other.getAddress());

            // Slash is a pure accounting move: bond -> LP assets.
            expect(await pool.totalAssets()).to.equal(assetsBefore);
            expect(await pool.totalLockedETH()).to.equal(0n);
            expect(await pool.operatorBond()).to.equal(ethers.parseEther("12"));
            expect(await pool.withdrawableETH()).to.equal(ethers.parseEther("10"));
            expect(await pool.lockedByChannel(channelId)).to.equal(0n);

            // The LP can now exit fully at the pre-expiry price.
            const allShares = await pool.sharesOf(await lp1.getAddress());
            const out = await pool.connect(lp1).withdraw.staticCall(allShares);
            expect(out).to.equal(ethers.parseEther("10"));
        });

        it("rejects settle and double-expire after expiry", async () => {
            await time.increase(Number(SETTLEMENT_WINDOW) + 1);
            await pool.connect(other).expireChannel(channelId);

            await expect(
                pool
                    .connect(operator)
                    .settleChannel(channelId, { value: withFeeFloor(principal) })
            ).to.be.revertedWith("Unknown channel");
            await expect(
                pool.connect(other).expireChannel(channelId)
            ).to.be.revertedWith("Unknown channel");
        });

        it("still allows the operator to settle before anyone expires", async () => {
            await time.increase(Number(SETTLEMENT_WINDOW) + 1);
            await pool
                .connect(operator)
                .settleChannel(channelId, { value: withFeeFloor(principal) });

            expect(await pool.totalLockedETH()).to.equal(0n);
            expect(await pool.operatorBond()).to.equal(ethers.parseEther("20"));
        });
    });

    describe("adversarial", () => {
        it("blocks reentrant withdraw", async () => {
            const factory = await ethers.getContractFactory("LiquidityPoolReentrant");
            const attacker = await factory.deploy(await pool.getAddress());
            await attacker.waitForDeployment();

            await attacker.depositToPool({ value: ethers.parseEther("2") });
            await pool.connect(lp1).deposit({ value: ethers.parseEther("2") });

            // Re-entering withdraw from the receive hook trips the guard and
            // reverts the whole withdrawal.
            await expect(
                attacker.withdrawFromPool(ethers.parseEther("1"), true)
            ).to.be.reverted;

            // Without the re-entry the same withdrawal succeeds.
            await attacker.withdrawFromPool(ethers.parseEther("1"), false);
            expect(
                await pool.sharesOf(await attacker.getAddress())
            ).to.equal(ethers.parseEther("1"));
        });

        it("makes first-depositor share inflation unprofitable", async () => {
            // Attacker mints dust shares, then force-donates to inflate the
            // share price before the victim deposits.
            await pool.connect(other).deposit({ value: 1n });
            const donation = ethers.parseEther("5");
            const forceSend = await ethers.getContractFactory("ForceSend");
            await forceSend.deploy(await pool.getAddress(), { value: donation });

            const victimDeposit = ethers.parseEther("10");
            await pool.connect(lp1).deposit({ value: victimDeposit });

            // The virtual offset keeps the victim's mint non-zero and caps the
            // attacker's proceeds below the attack cost.
            const victimShares = await pool.sharesOf(await lp1.getAddress());
            expect(victimShares).to.be.greaterThan(0n);

            const attackerShares = await pool.sharesOf(await other.getAddress());
            const attackerOut = await pool.previewWithdrawETH(attackerShares);
            const attackerCost = donation + 1n;
            expect(attackerOut).to.be.lessThan(attackerCost);
        });

        it("rejects plain ETH transfers", async () => {
            await expect(
                lp1.sendTransaction({ to: await pool.getAddress(), value: 1n })
            ).to.be.revertedWith("Use deposit, bondETH or settleChannel");
        });
    });

    describe("end-to-end", () => {
        it("deposit -> bond -> fund -> settle -> withdraw path", async () => {
            await pool.connect(lp1).deposit({ value: ethers.parseEther("10") });
            await bond(ethers.parseEther("10"));

            const channelId = cid("e2e");
            await pool.connect(operator).fundChannel(channelId, ethers.parseEther("8"));
            await pool
                .connect(operator)
                .settleChannel(channelId, { value: ethers.parseEther("9") });

            const allShares = await pool.sharesOf(await lp1.getAddress());
            const out = await pool.connect(lp1).withdraw.staticCall(allShares);
            // The +1 virtual share retains 1 wei of dust in the pool.
            expect(out).to.equal(ethers.parseEther("11") - 1n);

            await pool.connect(lp1).withdraw(allShares);
            expect(await pool.totalShares()).to.equal(0n);
            expect(await pool.totalLockedETH()).to.equal(0n);
            expect(await pool.totalAssets()).to.equal(1n);

            // The operator can still recover the full bond afterwards.
            await pool.connect(operator).withdrawBond(ethers.parseEther("10"));
            expect(await pool.operatorBond()).to.equal(0n);
        });
    });
});
