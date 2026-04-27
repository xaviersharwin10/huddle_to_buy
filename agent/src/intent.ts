import { createHash, randomBytes } from "node:crypto";

export type Intent = {
  sku: string;
  max_unit_price: number;
  deadline_ms: number;
  qty: number;
};

export const TIER_STEP = 0.5;
export const DEADLINE_BUCKET_MS = 6 * 60 * 60 * 1000;

export function canonicalSku(sku: string): string {
  return sku.trim().toLowerCase();
}

// Round UP: a buyer at max=$1.85 lands in tier 4 ($2.00 ceiling), same as
// a buyer at max=$2.00. Both can accept any offer ≤ $2.00, so they should
// produce the same commitment hash.
export function tierBucket(maxUnitPrice: number): number {
  return Math.ceil(maxUnitPrice / TIER_STEP);
}

export function deadlineBucket(deadlineMs: number): number {
  return Math.floor(deadlineMs / DEADLINE_BUCKET_MS);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// v1 commitment is deterministic on (sku, tier, deadline). Two buyers with
// intersecting intents produce identical hashes — required for k-anonymous
// observation. Tradeoff: a passive observer can pre-image the SKU space.
// Acceptable threat model for v1; real prod would use PSI or similar.
export function commitment(intent: Intent): string {
  const skuH = sha256Hex(canonicalSku(intent.sku));
  const tier = tierBucket(intent.max_unit_price);
  const deadline = deadlineBucket(intent.deadline_ms);
  return sha256Hex(`${skuH}|${tier}|${deadline}`);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
