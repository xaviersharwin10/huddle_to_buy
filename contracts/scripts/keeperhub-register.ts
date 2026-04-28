import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const coalitionAddress = process.env.COALITION_ADDRESS;
  if (!coalitionAddress) {
    throw new Error("COALITION_ADDRESS is required");
  }

  const apiUrl = process.env.KEEPERHUB_API_URL ?? "";
  const apiKey = process.env.KEEPERHUB_API_KEY ?? "";
  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";

  const mappingPath = resolve(__dirname, "..", "keeperhub", "coalition-day5-mapping.json");
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as Record<string, unknown>;

  const payload = {
    ...mapping,
    contractAddress: coalitionAddress,
    metadata: {
      project: "huddle-to-buy",
      stage: "day5",
      createdAt: new Date().toISOString(),
    },
  };

  console.log("keeperhub registration payload:");
  console.log(JSON.stringify(payload, null, 2));

  if (dryRun) {
    console.log("DRY_RUN=true, skipping KeeperHub API call");
    return;
  }

  if (!apiUrl || !apiKey) {
    throw new Error("KEEPERHUB_API_URL and KEEPERHUB_API_KEY are required when DRY_RUN=false");
  }

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`KeeperHub registration failed: ${res.status} ${text}`);
  }

  console.log(`KeeperHub registration succeeded: ${text}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
