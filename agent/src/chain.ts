import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseUnits,
} from "viem";
// import { defineChain } from "viem";

export const gensynTestnet = defineChain({
  id: 685685,
  name: 'Gensyn Testnet',
  network: 'gensynTestnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || 'https://rpc.gensyn.dev'] },
    public: { http: [process.env.RPC_URL || 'https://rpc.gensyn.dev'] },
  },
});
import { privateKeyToAccount } from "viem/accounts";

const FACTORY_ABI = [
  {
    type: "function",
    name: "createCoalition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "skuHash", type: "bytes32" },
      { name: "tierUnitPrice", type: "uint256" },
      { name: "unitQty", type: "uint256" },
      { name: "requiredBuyers", type: "uint256" },
      { name: "validUntil", type: "uint256" },
      { name: "seller", type: "address" },
      { name: "keeper", type: "address" },
      { name: "payToken", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "CoalitionCreated",
    inputs: [
      { indexed: true, name: "coalition", type: "address" },
      { indexed: true, name: "skuHash", type: "bytes32" },
      { indexed: true, name: "seller", type: "address" },
      { indexed: false, name: "tierUnitPrice", type: "uint256" },
      { indexed: false, name: "unitQty", type: "uint256" },
      { indexed: false, name: "requiredBuyers", type: "uint256" },
      { indexed: false, name: "validUntil", type: "uint256" },
    ],
    anonymous: false,
  },
] as const;

const COALITION_ABI = [
  {
    type: "function",
    name: "unitPriceTotal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const BUYER_PROFILE_ABI = [
  {
    type: "function",
    name: "mintProfile",
    stateMutability: "nonpayable",
    inputs: [{ name: "storageUri", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type OnchainConfig = {
  rpcUrl: string;
  chainId: number;
  privateKey: `0x${string}`;
  factoryAddress: `0x${string}`;
  keeperAddress: `0x${string}`;
  sellerAddress: `0x${string}`;
  payTokenAddress: `0x${string}`;
  payTokenDecimals: number;
};

/** 0G iNFT config — distinct from the Gensyn Testnet OnchainConfig because it
 *  targets a different chain. All fields optional; if any are missing, mint
 *  is skipped. */
export type ZeroGProfileConfig = {
  rpcUrl: string;
  chainId: number;
  privateKey: `0x${string}`;
  buyerProfileAddress: `0x${string}`;
};

export function createOnchainConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OnchainConfig | null {
  const rpcUrl = env.RPC_URL ?? "";
  const chainId = Number(env.CHAIN_ID ?? "685685");
  const privateKey = env.PRIVATE_KEY ?? "";
  const factoryAddress = env.FACTORY_ADDRESS ?? "";
  const keeperAddress = env.KEEPER_ADDRESS ?? "";
  const sellerAddress = env.SELLER_ADDRESS ?? "";
  const payTokenAddress = env.PAY_TOKEN_ADDRESS ?? "";
  const payTokenDecimals = Number(env.PAY_TOKEN_DECIMALS ?? "6");

  if (
    !rpcUrl ||
    !privateKey ||
    !factoryAddress ||
    !keeperAddress ||
    !sellerAddress ||
    !payTokenAddress
  ) {
    return null;
  }

  return {
    rpcUrl,
    chainId,
    privateKey: normalizeHex(privateKey),
    factoryAddress: normalizeHex(factoryAddress),
    keeperAddress: normalizeHex(keeperAddress),
    sellerAddress: normalizeHex(sellerAddress),
    payTokenAddress: normalizeHex(payTokenAddress),
    payTokenDecimals,
  };
}

export function createZeroGProfileConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ZeroGProfileConfig | null {
  const rpcUrl = env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const chainId = Number(env.ZEROG_CHAIN_ID ?? "16600");
  const privateKey = env.ZEROG_PRIVATE_KEY ?? env.PRIVATE_KEY ?? "";
  const buyerProfileAddress = env.BUYER_PROFILE_ADDRESS ?? "";

  if (!privateKey || !buyerProfileAddress) return null;

  return {
    rpcUrl,
    chainId,
    privateKey: normalizeHex(privateKey),
    buyerProfileAddress: normalizeHex(buyerProfileAddress),
  };
}

export function toTokenUnits(value: number, decimals: number): bigint {
  return parseUnits(value.toString(), decimals);
}

export async function deployCoalition(args: {
  cfg: OnchainConfig;
  skuHash: `0x${string}`;
  tierUnitPrice: bigint;
  unitQty: number;
  requiredBuyers: number;
  validUntilMs: number;
}): Promise<`0x${string}`> {
  const { cfg, skuHash, tierUnitPrice, unitQty, requiredBuyers, validUntilMs } = args;

  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({
    account,
    chain: gensynTestnet,
    transport: http(cfg.rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: gensynTestnet,
    transport: http(cfg.rpcUrl),
  });

  const hash = await wallet.writeContract({
    address: cfg.factoryAddress,
    abi: FACTORY_ABI,
    functionName: "createCoalition",
    args: [
      skuHash,
      tierUnitPrice,
      BigInt(unitQty),
      BigInt(requiredBuyers),
      BigInt(Math.floor(validUntilMs / 1000)),
      cfg.sellerAddress,
      cfg.keeperAddress,
      cfg.payTokenAddress,
    ],
    gas: 1_000_000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics });
      if (parsed.eventName === "CoalitionCreated") {
        return parsed.args.coalition;
      }
    } catch {
      // unrelated log
    }
  }

  throw new Error(`missing CoalitionCreated event in tx ${hash}`);
}

/** Approve + fund a Coalition for the configured buyer.
 *
 *  x402 note: in a fuller integration the call into fund() would be wrapped by
 *  an x402-payable HTTP endpoint (e.g. a hosted /pay route returning 402 with
 *  payment metadata, satisfied by an x402 client wallet). Doing that requires
 *  hosting an x402 endpoint and standing up a CDP-backed wallet — out of scope
 *  for the 8-day build. Here we call fund() directly via viem; this is an honest
 *  on-chain payment but not an x402-wrapped one. */
export async function fundCoalitionForBuyer(args: {
  cfg: OnchainConfig;
  coalitionAddress: `0x${string}`;
}): Promise<{ approveTx?: `0x${string}`; fundTx: `0x${string}` }> {
  const { cfg, coalitionAddress } = args;
  const account = privateKeyToAccount(cfg.privateKey);

  const wallet = createWalletClient({
    account,
    chain: gensynTestnet,
    transport: http(cfg.rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: gensynTestnet,
    transport: http(cfg.rpcUrl),
  });

  // Read the slice with a few retries — RPCs sometimes lag right after deployment.
  let slice: bigint | undefined;
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      slice = await publicClient.readContract({
        address: coalitionAddress,
        abi: COALITION_ABI,
        functionName: "unitPriceTotal",
        args: [],
      });
      break;
    } catch (e) {
      lastErr = e;
      if (i < 4) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (slice === undefined) throw lastErr ?? new Error("unitPriceTotal read failed");

  const currentAllowance = await publicClient.readContract({
    address: cfg.payTokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, coalitionAddress],
  });

  let approveTx: `0x${string}` | undefined;
  if (currentAllowance < slice) {
    approveTx = await wallet.writeContract({
      address: cfg.payTokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [coalitionAddress, slice],
      gas: 100_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const fundTx = await wallet.writeContract({
    address: coalitionAddress,
    abi: COALITION_ABI,
    functionName: "fund",
    args: [],
    gas: 500_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });

  return { approveTx, fundTx };
}

/** Mint an ERC-7857-style Buyer Profile iNFT on 0G testnet.
 *
 *  Returns the tx hash on success, or null when not configured.
 *  Configuration is via env: BUYER_PROFILE_ADDRESS (deployed contract on 0G)
 *  and ZEROG_PRIVATE_KEY (or PRIVATE_KEY as fallback).
 *
 *  On any failure we surface the error to the caller — no fake-success returns. */
export async function mintBuyerProfile0G(
  cfg: ZeroGProfileConfig | null,
  storageUri: string,
): Promise<`0x${string}` | null> {
  if (!cfg) return null;

  const chain = defineChain({
    id: cfg.chainId,
    name: "0G Testnet",
    nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });

  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  const hash = await wallet.writeContract({
    address: cfg.buyerProfileAddress,
    abi: BUYER_PROFILE_ABI,
    functionName: "mintProfile",
    args: [storageUri],
    gas: 300_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function normalizeHex(s: string): `0x${string}` {
  const v = s.trim();
  return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
}
