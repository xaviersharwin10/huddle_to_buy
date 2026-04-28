import { ethers } from "hardhat";

async function main() {
  const coalitionAddress = process.env.COALITION_ADDRESS;
  if (!coalitionAddress) {
    throw new Error("COALITION_ADDRESS is required");
  }
  const rpcUrl = process.env.RPC_URL ?? process.env.GENSYN_TESTNET_RPC ?? "https://gensyn-testnet.g.alchemy.com/public";
  if (!rpcUrl) {
    throw new Error("RPC_URL (or GENSYN_TESTNET_RPC) is required");
  }
  const keeperPk = process.env.KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!keeperPk) {
    throw new Error("KEEPER_PRIVATE_KEY (or PRIVATE_KEY) is required");
  }

  const pollMs = Number(process.env.POLL_MS ?? "5000");
  const stopOnTerminal = (process.env.STOP_ON_TERMINAL ?? "true").toLowerCase() === "true";

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const keeper = new ethers.Wallet(normalizeHex(keeperPk), provider);
  console.log(`keeper: ${keeper.address}`);
  console.log(`coalition: ${coalitionAddress}`);

  const coalition = new ethers.Contract(
    coalitionAddress,
    [
      "function state() view returns (uint8)",
      "function requiredBuyers() view returns (uint256)",
      "function buyerCount() view returns (uint256)",
      "function validUntil() view returns (uint256)",
      "function commit()",
      "function refundAll()",
    ],
    keeper,
  );

  while (true) {
    const state = Number(await coalition.state());
    const required = Number(await coalition.requiredBuyers());
    const funded = Number(await coalition.buyerCount());
    const validUntil = Number(await coalition.validUntil());
    const now = Math.floor(Date.now() / 1000);

    console.log(`tick state=${stateLabel(state)} funded=${funded}/${required} now=${now} validUntil=${validUntil}`);

    if (state === 1) {
      const tx = await coalition.commit();
      await tx.wait();
      console.log(`commit tx=${tx.hash}`);
      if (stopOnTerminal) break;
    } else if ((state === 0 || state === 1) && now > validUntil) {
      const tx = await coalition.refundAll();
      await tx.wait();
      console.log(`refundAll tx=${tx.hash}`);
      if (stopOnTerminal) break;
    } else if ((state === 2 || state === 3) && stopOnTerminal) {
      break;
    }

    await sleep(pollMs);
  }
}

function stateLabel(s: number): string {
  if (s === 0) return "Forming";
  if (s === 1) return "Funded";
  if (s === 2) return "Committed";
  if (s === 3) return "Refunded";
  return `Unknown(${s})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHex(s: string): `0x${string}` {
  const v = s.trim();
  return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
