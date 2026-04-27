import { ethers } from "hardhat";

async function main() {
  console.log("Deploying BuyerProfile iNFT to 0G Testnet...");

  const BuyerProfile = await ethers.getContractFactory("BuyerProfile");
  const profile = await BuyerProfile.deploy();
  await profile.waitForDeployment();

  const addr = await profile.getAddress();
  console.log(`BuyerProfile deployed to: ${addr}`);
  console.log("Ready to mint agent preferences to 0G Storage pointers.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
