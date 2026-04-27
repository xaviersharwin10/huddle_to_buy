import { ethers, network } from "hardhat";

// Deploy MockUSDC and CoalitionFactory to Gensyn Testnet
async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer signer found. Set PRIVATE_KEY in contracts/.env for gensynTestnet network.");
  }
  const [deployer] = signers;
  console.log(`network: ${network.name}`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // Deploy MockUSDC first
  const usdcF = await ethers.getContractFactory("MockUSDC");
  const usdc = await usdcF.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log(`MockUSDC:         ${usdcAddr}`);

  // Deploy CoalitionFactory
  const factoryF = await ethers.getContractFactory("CoalitionFactory");
  const factory = await factoryF.deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`CoalitionFactory: ${factoryAddr}`);

  console.log(JSON.stringify({
    network: network.name,
    factory: factoryAddr,
    payToken: usdcAddr,
    deployer: deployer.address,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
