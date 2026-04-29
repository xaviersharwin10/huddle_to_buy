// check-usdc.js — quick MockUSDC balance check on Gensyn Testnet
// Usage: WALLET_ADDRESS=0x... PAY_TOKEN_ADDRESS=0x... node check-usdc.js
const ethers = require("ethers");

const RPC = process.env.RPC_URL || "https://gensyn-testnet.g.alchemy.com/public";
const WALLET = process.env.WALLET_ADDRESS;
const USDC = process.env.PAY_TOKEN_ADDRESS;

if (!WALLET || !USDC) {
  console.error("WALLET_ADDRESS and PAY_TOKEN_ADDRESS env vars are required");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);

const ABI = ["function balanceOf(address) view returns (uint256)"];
const usdc = new ethers.Contract(USDC, ABI, provider);

usdc.balanceOf(WALLET).then(balance => {
  console.log("USDC Balance:", ethers.formatUnits(balance, 6), "USDC");
});
