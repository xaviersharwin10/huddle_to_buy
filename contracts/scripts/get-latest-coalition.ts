import { createPublicClient, http, parseAbiItem } from "viem";
import { defineChain } from "viem";

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

const RPC_URL = process.env.RPC_URL ?? "https://gensyn-testnet.g.alchemy.com/public";
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS ?? "";

async function main() {
  if (!FACTORY_ADDRESS) {
    console.error("FACTORY_ADDRESS env var is required");
    process.exit(1);
  }

  const publicClient = createPublicClient({
    chain: gensynTestnet,
    transport: http(RPC_URL),
  });

  console.log("Fetching recent CoalitionCreated events...");
  const currentBlock = await publicClient.getBlockNumber();
  const fromBlock = currentBlock - 9900n; // look back ~9900 blocks

  const logs = await publicClient.getLogs({
    address: FACTORY_ADDRESS as `0x${string}`,
    event: parseAbiItem('event CoalitionCreated(address indexed coalition, bytes32 indexed skuHash, address indexed seller, uint256 tierUnitPrice, uint256 unitQty, uint256 requiredBuyers, uint256 validUntil)'),
    fromBlock,
    toBlock: 'latest'
  });

  if (logs.length === 0) {
    console.log("No CoalitionCreated events found recently.");
  } else {
    const latest = logs[logs.length - 1];
    console.log(`LATEST COALITION ADDRESS: ${latest.args.coalition}`);
    console.log(`Transaction Hash: ${latest.transactionHash}`);
    console.log(`Valid Until: ${latest.args.validUntil} (Now: ${Math.floor(Date.now() / 1000)})`);
  }
}

main().catch(console.error);
