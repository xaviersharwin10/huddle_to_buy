// fund-buyer.ts  — one-shot: approve + call fund() for a given buyer on a known coalition
// Usage: PRIVATE_KEY=0x... COALITION_ADDRESS=0x... pnpm exec tsx scripts/fund-buyer.ts
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
} from "viem";

export const gensynTestnet = defineChain({
  id: 685685,
  name: 'Gensyn Testnet',
  network: 'gensynTestnet',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || 'https://rpc.gensyn.dev'] },
    public: { http: [process.env.RPC_URL || 'https://rpc.gensyn.dev'] },
  },
});
import { privateKeyToAccount } from "viem/accounts";

const COALITION_ABI = [
  { type:"function", name:"unitPriceTotal", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"fund",           stateMutability:"nonpayable", inputs:[], outputs:[] },
  { type:"function", name:"state",          stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint8"}] },
  { type:"function", name:"buyerCount",     stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"requiredBuyers", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"validUntil",     stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"funded",         stateMutability:"view", inputs:[{name:"",type:"address"}], outputs:[{name:"",type:"uint256"}] },
] as const;

const ERC20_ABI = [
  { type:"function", name:"allowance", stateMutability:"view", inputs:[{name:"owner",type:"address"},{name:"spender",type:"address"}], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"approve",   stateMutability:"nonpayable", inputs:[{name:"spender",type:"address"},{name:"value",type:"uint256"}], outputs:[{name:"",type:"bool"}] },
  { type:"function", name:"balanceOf", stateMutability:"view", inputs:[{name:"account",type:"address"}], outputs:[{name:"",type:"uint256"}] },
] as const;

function norm(s: string): `0x${string}` {
  return (s.trim().startsWith("0x") ? s.trim() : `0x${s.trim()}`) as `0x${string}`;
}

async function main() {
  const pk              = process.env.PRIVATE_KEY ?? "";
  const coalitionAddr   = process.env.COALITION_ADDRESS ?? "";
  const rpcUrl          = process.env.RPC_URL ?? "https://gensyn-testnet.g.alchemy.com/public";
  const payTokenAddr    = process.env.PAY_TOKEN_ADDRESS ?? "";

  if (!pk || !coalitionAddr || !payTokenAddr) {
    console.error("PRIVATE_KEY, COALITION_ADDRESS, and PAY_TOKEN_ADDRESS are required");
    process.exit(1);
  }

  const account     = privateKeyToAccount(norm(pk));
  const publicClient = createPublicClient({ chain: gensynTestnet, transport: http(rpcUrl) });
  const wallet      = createWalletClient({ account, chain: gensynTestnet, transport: http(rpcUrl) });

  console.log(`buyer:     ${account.address}`);
  console.log(`coalition: ${coalitionAddr}`);

  // Read coalition state
  const [stateRaw, buyerCount, required, validUntil] = await Promise.all([
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "state" }),
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "buyerCount" }),
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "requiredBuyers" }),
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "validUntil" }),
  ]);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const stateLabels = ["Forming","Funded","Committed","Refunded"];
  console.log(`state:     ${stateLabels[Number(stateRaw)]}  funded=${buyerCount}/${required}  validUntil=${validUntil} (now=${nowSec} ttl=${Number(validUntil-nowSec)}s)`);

  if (Number(stateRaw) !== 0 /*Forming*/) {
    console.log("Coalition is not in Forming state — nothing to do");
    process.exit(0);
  }
  if (validUntil <= nowSec) {
    console.log("Coalition has already expired");
    process.exit(1);
  }

  // Check if already funded
  const myFunded = await publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "funded", args: [account.address] });
  if (myFunded > 0n) {
    console.log(`Already funded (amount=${myFunded}). Nothing to do.`);
    process.exit(0);
  }

  // Get amount needed
  const slice = await publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "unitPriceTotal" });
  console.log(`unitPriceTotal: ${slice} (${Number(slice)/1e6} USDC)`);

  // Check USDC balance
  const bal = await publicClient.readContract({ address: norm(payTokenAddr), abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`USDC balance:   ${bal} (${Number(bal)/1e6} USDC)`);
  if (bal < slice) {
    console.error(`INSUFFICIENT BALANCE: need ${slice}, have ${bal}`);
    process.exit(1);
  }

  // Approve if needed
  const allowance = await publicClient.readContract({ address: norm(payTokenAddr), abi: ERC20_ABI, functionName: "allowance", args: [account.address, norm(coalitionAddr)] });
  console.log(`current allowance: ${allowance}`);
  if (allowance < slice) {
    console.log("Approving...");
    const approveTx = await wallet.writeContract({ address: norm(payTokenAddr), abi: ERC20_ABI, functionName: "approve", args: [norm(coalitionAddr), slice], gas: 100000n });
    console.log(`approve tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log("approve confirmed");
  } else {
    console.log("Allowance already sufficient — skipping approve");
  }

  // Fund
  console.log("Calling fund()...");
  const fundTx = await wallet.writeContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "fund", args: [], gas: 500000n });
  console.log(`fund tx: ${fundTx}`);
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log("fund() confirmed! ✅");

  // Re-read state
  const [newState, newCount] = await Promise.all([
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "state" }),
    publicClient.readContract({ address: norm(coalitionAddr), abi: COALITION_ABI, functionName: "buyerCount" }),
  ]);
  console.log(`new state: ${stateLabels[Number(newState)]}  funded=${newCount}/${required}`);
}

main().catch(e => { console.error(e); process.exit(1); });
