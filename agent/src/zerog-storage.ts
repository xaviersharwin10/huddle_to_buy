/**
 * 0G Storage integration — real off-chain writes for Huddle-to-Buy.
 *
 * Two write paths:
 *   1. uploadProfileBlob()   — agent preferences JSON → 0G Storage file layer
 *                              returns a 0g:// URI built from the content root hash
 *   2. writeCoalitionKv()    — coalition outcome → 0G KV store (Batcher path)
 *
 * Both are best-effort: callers catch errors and fall back gracefully.
 *
 * Required env:
 *   ZEROG_RPC_URL        0G EVM RPC     (default https://evmrpc-testnet.0g.ai)
 *   ZEROG_INDEXER_URL    0G indexer     (default https://indexer-storage-testnet-turbo.0g.ai)
 *   ZEROG_FLOW_ADDRESS   0G Flow contract address (see docs.0g.ai)
 *   ZEROG_PRIVATE_KEY    key with A0GI for gas (falls back to PRIVATE_KEY)
 */

import { Indexer, MemData, Batcher, getFlowContract } from "@0glabs/0g-ts-sdk";
import { ethers } from "ethers";

export type ZeroGStorageConfig = {
  rpcUrl: string;
  indexerUrl: string;
  flowAddress: string;
  privateKey: string;
};

export function createZeroGStorageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ZeroGStorageConfig | null {
  const rpcUrl = env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const indexerUrl =
    env.ZEROG_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai";
  const flowAddress = env.ZEROG_FLOW_ADDRESS ?? "";
  const privateKey = env.ZEROG_PRIVATE_KEY ?? env.PRIVATE_KEY ?? "";

  if (!flowAddress || !privateKey) return null;

  return {
    rpcUrl,
    indexerUrl,
    flowAddress,
    privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
  };
}

function makeSigner(cfg: ZeroGStorageConfig): ethers.Wallet {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  return new ethers.Wallet(cfg.privateKey, provider);
}

/**
 * Uploads a JSON blob to 0G Storage using the file layer.
 * Returns `0g://huddle-buyer/v1/<rootHash>` on success.
 *
 * The rootHash is a Merkle commitment over the data and is verifiable by any
 * 0G storage node: `indexer.download(rootHash, outputPath, true)`.
 */
export async function uploadProfileBlob(
  cfg: ZeroGStorageConfig,
  data: Buffer,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signer = makeSigner(cfg) as any; // ESM/CJS ethers dual-publish compat cast

  const memData = new MemData(data);
  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr) throw new Error(`Merkle tree: ${treeErr.message}`);
  const rootHash = tree!.rootHash();

  const indexer = new Indexer(cfg.indexerUrl);
  const [, uploadErr] = await indexer.upload(memData, cfg.rpcUrl, signer);
  if (uploadErr) throw new Error(`0G upload: ${uploadErr.message}`);

  return `0g://huddle-buyer/v1/${rootHash}`;
}

/**
 * Writes a coalition outcome record to 0G KV storage via the Batcher.
 *
 * streamId = keccak256("huddle-to-buy/v1")  — deterministic app namespace
 * key      = keccak256(coalitionAddress)     — per-coalition slot
 * value    = JSON { coalitionAddress, sku, tokenId, ts }
 *
 * Returns the on-chain transaction hash, or null if already uploaded.
 */
export async function writeCoalitionKv(
  cfg: ZeroGStorageConfig,
  coalitionAddress: string,
  sku: string,
  tokenId: bigint,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signer = makeSigner(cfg) as any; // ESM/CJS ethers dual-publish compat cast

  const flowContract = getFlowContract(cfg.flowAddress, signer);
  const indexer = new Indexer(cfg.indexerUrl);

  const [nodes, nodeErr] = await indexer.selectNodes(1);
  if (nodeErr) throw new Error(`0G selectNodes: ${nodeErr.message}`);

  // Stream ID: deterministic keccak256 of the project namespace string.
  const streamId = ethers.keccak256(ethers.toUtf8Bytes("huddle-to-buy/v1"));

  const batcher = new Batcher(1, nodes, flowContract, cfg.rpcUrl);

  const key = ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(coalitionAddress.toLowerCase())),
  );
  const value = Buffer.from(
    JSON.stringify({
      coalitionAddress,
      sku,
      tokenId: tokenId.toString(),
      ts: Date.now(),
      project: "huddle-to-buy",
    }),
  );

  batcher.streamDataBuilder.set(streamId, key, value);
  const [result, batchErr] = await batcher.exec();
  if (batchErr) throw new Error(`0G KV batcher: ${batchErr.message}`);

  return result?.txHash ?? null;
}
