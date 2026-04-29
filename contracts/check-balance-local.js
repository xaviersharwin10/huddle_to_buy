// check-balance-local.js — print ETH + MockUSDC balance for a Gensyn Testnet wallet
// Usage:
//   WALLET_ADDRESS=0x... PAY_TOKEN_ADDRESS=0x... node check-balance-local.js
//   PAY_TOKEN_ADDRESS=0x... node check-balance-local.js 0x...
const ethers = require("ethers");

const RPC = process.env.RPC_URL || "https://gensyn-testnet.g.alchemy.com/public";
const WALLET = process.env.WALLET_ADDRESS || process.argv[2];
const USDC = process.env.PAY_TOKEN_ADDRESS;

if (!WALLET) {
  console.error("Usage: WALLET_ADDRESS=0x... PAY_TOKEN_ADDRESS=0x... node check-balance-local.js");
  console.error("   or: PAY_TOKEN_ADDRESS=0x... node check-balance-local.js <wallet-address>");
  process.exit(1);
}
if (!USDC) {
  console.error("PAY_TOKEN_ADDRESS env var is required (MockUSDC address from deploy.ts output)");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
console.log(`RPC:    ${RPC}`);
console.log(`Wallet: ${WALLET}`);
console.log(`USDC:   ${USDC}`);
console.log("");

// Check ETH balance
provider.getBalance(WALLET).then(balance => {
  console.log("ETH Balance: ", ethers.formatEther(balance), "ETH");
});

// Check USDC balance
const ABI = ["function balanceOf(address) view returns (uint256)"];
const usdc = new ethers.Contract(USDC, ABI, provider);

usdc.balanceOf(WALLET).then(balance => {
  console.log("USDC Balance:", ethers.formatUnits(balance, 6), "USDC");
});
