import { ethers, network } from "hardhat";

async function main() {
  const PAY_TOKEN = process.env.PAY_TOKEN_ADDRESS;
  const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
  const AMOUNT = process.env.AMOUNT || "10000";

  if (!PAY_TOKEN || !WALLET_ADDRESS) {
    console.error("Usage: PAY_TOKEN_ADDRESS=0x... ts-node mint-mock-usdc.ts <wallet-address> [amount]");
    process.exit(1);
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer signer found. Set PRIVATE_KEY in contracts/.env.");
  }
  const [deployer] = signers;
  
  console.log(`network: ${network.name}`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`minting ${AMOUNT} MockUSDC to ${WALLET_ADDRESS}...`);

  const usdcF = await ethers.getContractFactory("MockUSDC");
  const usdc = usdcF.attach(PAY_TOKEN) as any;

  // Mint amount (6 decimals)
  const amountParsed = ethers.parseUnits(AMOUNT, 6);
  const tx = await usdc.mint(WALLET_ADDRESS, amountParsed);
  console.log(`tx hash: ${tx.hash}`);
  await tx.wait();
  console.log("mint complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
