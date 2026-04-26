import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// USDC has 6 decimals.
const usdc = (n: string | number) => ethers.parseUnits(String(n), 6);
const SKU_HASH = ethers.keccak256(ethers.toUtf8Bytes("h100-pcie-hour"));

describe("Coalition", () => {
  async function deploy(opts?: { unitQty?: bigint; required?: bigint; validForSecs?: number }) {
    const [deployer, seller, keeper, alice, bob, carol] = await ethers.getSigners();

    const usdcFactory = await ethers.getContractFactory("MockUSDC");
    const token = await usdcFactory.deploy();
    await token.waitForDeployment();

    // Pre-fund the buyers.
    for (const b of [alice, bob, carol]) {
      await (await token.mint(b.address, usdc(1000))).wait();
    }

    const validUntil = (await time.latest()) + (opts?.validForSecs ?? 3600);
    const factory = await ethers.getContractFactory("Coalition");
    const c = await factory.deploy(
      SKU_HASH,
      usdc(1.3),                 // tier unit price
      opts?.unitQty ?? 100n,     // qty per buyer
      opts?.required ?? 3n,
      validUntil,
      seller.address,
      keeper.address,
      await token.getAddress(),
    );
    await c.waitForDeployment();

    return { c, token, seller, keeper, alice, bob, carol, validUntil };
  }

  it("happy path: 3 buyers fund -> keeper commits -> seller paid", async () => {
    const { c, token, seller, keeper, alice, bob, carol } = await deploy();
    const slice = await c.unitPriceTotal();

    for (const b of [alice, bob, carol]) {
      await (await token.connect(b).approve(await c.getAddress(), slice)).wait();
    }

    await expect(c.connect(alice).fund()).to.emit(c, "BuyerFunded").withArgs(alice.address, slice, 1);
    expect(await c.state()).to.equal(0n); // Forming

    await c.connect(bob).fund();
    expect(await c.state()).to.equal(0n); // still Forming
    expect(await c.buyerCount()).to.equal(2n);

    await expect(c.connect(carol).fund()).to.emit(c, "BuyerFunded").withArgs(carol.address, slice, 3);
    expect(await c.state()).to.equal(1n); // Funded

    await expect(c.connect(keeper).commit())
      .to.emit(c, "CoalitionCommitted")
      .withArgs(slice * 3n);
    expect(await c.state()).to.equal(2n); // Committed
    expect(await token.balanceOf(seller.address)).to.equal(slice * 3n);
    expect(await token.balanceOf(await c.getAddress())).to.equal(0n);
  });

  it("rejects double-fund from same buyer", async () => {
    const { c, token, alice } = await deploy();
    const slice = await c.unitPriceTotal();
    await (await token.connect(alice).approve(await c.getAddress(), slice * 2n)).wait();
    await c.connect(alice).fund();
    await expect(c.connect(alice).fund()).to.be.revertedWithCustomError(c, "AlreadyFunded");
  });

  it("rejects commit before threshold", async () => {
    const { c, token, keeper, alice, bob } = await deploy();
    const slice = await c.unitPriceTotal();
    for (const b of [alice, bob]) {
      await (await token.connect(b).approve(await c.getAddress(), slice)).wait();
      await c.connect(b).fund();
    }
    await expect(c.connect(keeper).commit()).to.be.revertedWithCustomError(c, "WrongState");
  });

  it("rejects commit from non-keeper", async () => {
    const { c, token, alice, bob, carol } = await deploy();
    const slice = await c.unitPriceTotal();
    for (const b of [alice, bob, carol]) {
      await (await token.connect(b).approve(await c.getAddress(), slice)).wait();
      await c.connect(b).fund();
    }
    await expect(c.connect(alice).commit()).to.be.revertedWithCustomError(c, "NotKeeper");
  });

  it("keeper can refund mid-Forming (drop-out replay)", async () => {
    const { c, token, keeper, alice, bob } = await deploy();
    const slice = await c.unitPriceTotal();
    const aliceBefore = await token.balanceOf(alice.address);

    for (const b of [alice, bob]) {
      await (await token.connect(b).approve(await c.getAddress(), slice)).wait();
      await c.connect(b).fund();
    }

    await expect(c.connect(keeper).refundAll())
      .to.emit(c, "CoalitionRefunded")
      .withArgs(2);

    expect(await c.state()).to.equal(3n); // Refunded
    expect(await token.balanceOf(alice.address)).to.equal(aliceBefore);
    expect(await token.balanceOf(bob.address)).to.equal(aliceBefore);
  });

  it("anyone can refund after validUntil expires", async () => {
    const { c, token, alice } = await deploy({ validForSecs: 60 });
    const slice = await c.unitPriceTotal();
    await (await token.connect(alice).approve(await c.getAddress(), slice)).wait();
    await c.connect(alice).fund();

    // Non-keeper refund should fail before expiry.
    await expect(c.connect(alice).refundAll()).to.be.revertedWithCustomError(c, "NotKeeper");

    await time.increase(120);

    // Now any caller can trigger refund.
    await expect(c.connect(alice).refundAll()).to.emit(c, "CoalitionRefunded");
    expect(await c.state()).to.equal(3n);
  });

  it("rejects fund after validUntil", async () => {
    const { c, token, alice } = await deploy({ validForSecs: 60 });
    const slice = await c.unitPriceTotal();
    await (await token.connect(alice).approve(await c.getAddress(), slice)).wait();
    await time.increase(120);
    await expect(c.connect(alice).fund()).to.be.revertedWithCustomError(c, "Expired");
  });

  describe("CoalitionFactory", () => {
    it("deploys a Coalition and emits", async () => {
      const [_, seller, keeper] = await ethers.getSigners();
      const usdcF = await ethers.getContractFactory("MockUSDC");
      const token = await usdcF.deploy();
      await token.waitForDeployment();

      const fF = await ethers.getContractFactory("CoalitionFactory");
      const f = await fF.deploy();
      await f.waitForDeployment();

      const validUntil = (await time.latest()) + 3600;
      const tx = await f.createCoalition(
        SKU_HASH, usdc(1.3), 100n, 3n, validUntil,
        seller.address, keeper.address, await token.getAddress(),
      );
      const rcpt = await tx.wait();
      const ev = rcpt!.logs
        .map((l) => { try { return f.interface.parseLog(l); } catch { return null; } })
        .find((p) => p?.name === "CoalitionCreated");
      expect(ev).to.exist;
      expect(ev!.args.skuHash).to.equal(SKU_HASH);
      expect(ev!.args.seller).to.equal(seller.address);
      expect(ev!.args.requiredBuyers).to.equal(3n);
    });
  });
});
