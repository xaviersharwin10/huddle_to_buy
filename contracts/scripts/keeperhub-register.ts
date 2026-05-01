/**
 * KeeperHub workflow registration for Huddle Coalition contracts.
 *
 * Registers two automation workflows on KeeperHub's cloud platform:
 *   1. commit-on-threshold  — fires commit() when all buyers have funded
 *   2. refund-on-expiry     — fires refundAll() when deadline passes unfunded
 *
 * Env vars (loaded by hardhat.config.ts via dotenv.config()):
 *   COALITION_ADDRESS       deployed Coalition.sol address to watch
 *   KEEPERHUB_API_URL       KeeperHub API base URL (https://app.keeperhub.com)
 *   KEEPERHUB_API_KEY       Bearer token (kh_... format)
 *   DRY_RUN                 set to "false" to actually register (default: true)
 */

const BASE_URL = (process.env.KEEPERHUB_API_URL ?? "https://app.keeperhub.com")
  .replace(/\/$/, "");

async function khPost(path: string, apiKey: string, body: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`KeeperHub ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function khDelete(path: string, apiKey: string): Promise<void> {
  await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

function buildWorkflow(name: string, coalitionAddress: string, nodes: object[], edges: object[]) {
  return {
    name,
    nodes,
    edges,
    // Attach metadata as description for traceability in the KeeperHub dashboard.
    description: `Huddle-to-Buy coalition automation. Contract: ${coalitionAddress}. Project: huddle-to-buy / hackathon day-5.`,
  };
}

async function main() {
  const coalitionAddress = process.env.COALITION_ADDRESS;
  if (!coalitionAddress) throw new Error("COALITION_ADDRESS is required");

  const apiKey = process.env.KEEPERHUB_API_KEY ?? "";
  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";

  // ── Workflow 1: commit when all buyers have funded ────────────────────────
  const commitNodes = [
    {
      id: "trigger-buyer-funded",
      type: "trigger",
      data: {
        type: "trigger",
        label: "BuyerFunded event",
        config: {
          contractAddress: coalitionAddress,
          network: "gensynTestnet",
          chainId: 685685,
          event: "BuyerFunded(address,uint256,uint256)",
          fields: ["buyer", "amount", "fundedCount"],
        },
      },
      position: { x: 0, y: 0 },
    },
    {
      id: "condition-threshold",
      type: "condition",
      data: {
        type: "condition",
        label: "threshold met?",
        config: {
          expression: "funded_count == requiredBuyers && now <= validUntil && state == 1",
        },
      },
      position: { x: 300, y: 0 },
    },
    {
      id: "action-commit",
      type: "action",
      data: {
        type: "action",
        label: "commit()",
        config: {
          contractAddress: coalitionAddress,
          network: "gensynTestnet",
          chainId: 685685,
          function: "commit()",
        },
      },
      position: { x: 600, y: 0 },
    },
  ];
  const commitEdges = [
    { id: "e1", source: "trigger-buyer-funded", target: "condition-threshold" },
    { id: "e2", source: "condition-threshold", target: "action-commit" },
  ];

  // ── Workflow 2: refundAll when deadline passes ────────────────────────────
  const refundNodes = [
    {
      id: "trigger-funded-check",
      type: "trigger",
      data: {
        type: "trigger",
        label: "BuyerFunded event",
        config: {
          contractAddress: coalitionAddress,
          network: "gensynTestnet",
          chainId: 685685,
          event: "BuyerFunded(address,uint256,uint256)",
          fields: ["buyer", "amount", "fundedCount"],
        },
      },
      position: { x: 0, y: 0 },
    },
    {
      id: "condition-expired",
      type: "condition",
      data: {
        type: "condition",
        label: "deadline expired?",
        config: {
          expression: "now > validUntil && (state == 0 || state == 1)",
        },
      },
      position: { x: 300, y: 0 },
    },
    {
      id: "action-refund",
      type: "action",
      data: {
        type: "action",
        label: "refundAll()",
        config: {
          contractAddress: coalitionAddress,
          network: "gensynTestnet",
          chainId: 685685,
          function: "refundAll()",
        },
      },
      position: { x: 600, y: 0 },
    },
  ];
  const refundEdges = [
    { id: "e1", source: "trigger-funded-check", target: "condition-expired" },
    { id: "e2", source: "condition-expired", target: "action-refund" },
  ];

  const workflow1 = buildWorkflow(
    `huddle-commit-${coalitionAddress.slice(0, 8)}`,
    coalitionAddress,
    commitNodes,
    commitEdges,
  );
  const workflow2 = buildWorkflow(
    `huddle-refund-${coalitionAddress.slice(0, 8)}`,
    coalitionAddress,
    refundNodes,
    refundEdges,
  );

  console.log("KeeperHub registration payload (workflow 1 — commit-on-threshold):");
  console.log(JSON.stringify(workflow1, null, 2));
  console.log("\nKeeperHub registration payload (workflow 2 — refund-on-expiry):");
  console.log(JSON.stringify(workflow2, null, 2));

  if (dryRun) {
    console.log("\nDRY_RUN=true — skipping live API call. Set DRY_RUN=false to register.");
    return;
  }

  if (!apiKey) {
    throw new Error("KEEPERHUB_API_KEY is required when DRY_RUN=false");
  }

  console.log(`\nRegistering on KeeperHub (${BASE_URL})…`);

  const result1 = await khPost("/api/workflows/create", apiKey, workflow1);
  console.log(`✓ commit workflow registered: id=${result1.id} name=${result1.name}`);

  const result2 = await khPost("/api/workflows/create", apiKey, workflow2);
  console.log(`✓ refund workflow registered: id=${result2.id} name=${result2.name}`);

  console.log(`\nKeeperHub workflows live:`);
  console.log(`  commit:  ${BASE_URL}/workflows/${result1.id}`);
  console.log(`  refund:  ${BASE_URL}/workflows/${result2.id}`);
  console.log(`  coalition: ${coalitionAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
