import { AxlClient } from "./axl.js";

// Tier price card. Real-world shape: vast.ai / coreweave / RunPod reservation tiers.
// First-tier matched on minBuyers ascending; we pick the highest tier the buyer-count clears.
type Tier = { minBuyers: number; unitPrice: number };

const TIER_CARD: Record<string, Tier[]> = {
  "h100-pcie-hour": [
    { minBuyers: 1,  unitPrice: 1.99 },
    { minBuyers: 3,  unitPrice: 1.50 },
    { minBuyers: 10, unitPrice: 1.30 },
    { minBuyers: 30, unitPrice: 1.10 },
  ],
  "a100-pcie-hour": [
    { minBuyers: 1,  unitPrice: 1.20 },
    { minBuyers: 3,  unitPrice: 0.95 },
    { minBuyers: 10, unitPrice: 0.80 },
  ],
};

function pickTierPrice(sku: string, nBuyers: number): number | null {
  const tiers = TIER_CARD[sku];
  if (!tiers) return null;
  let chosen: number | null = null;
  for (const t of tiers) {
    if (nBuyers >= t.minBuyers) chosen = t.unitPrice;
  }
  return chosen;
}

export type NegotiateRequest = {
  v: 1;
  kind: "negotiate_request";
  from: string;        // coordinator pubkey
  commitment: string;  // correlation id
  sku: string;
  n_buyers: number;
  unit_qty: number;
  max_unit_price: number;
};

export type NegotiateResponse = {
  v: 1;
  kind: "negotiate_response";
  from: string;        // seller pubkey
  commitment: string;
  sku: string;
  n_buyers: number;
  unit_qty: number;
  tier_unit_price?: number; // present iff offered
  valid_until_ms?: number;  // offer expiry
  decline_reason?: string;
};

export class SellerAgent {
  private myPeerId = "";

  constructor(
    private readonly axl: AxlClient,
    private readonly log: (s: string) => void = console.log,
    private readonly offerValidForMs = 30 * 60 * 1000,
  ) {}

  async init(): Promise<void> {
    const t = await this.axl.topology();
    this.myPeerId = t.our_public_key;
    this.log(`seller init: pubkey=${this.myPeerId}`);
    const skus = Object.keys(TIER_CARD).join(", ");
    this.log(`seller offers SKUs: ${skus}`);
  }

  async runOnce(): Promise<boolean> {
    const m = await this.axl.recv();
    if (!m) return false;

    let env: NegotiateRequest;
    try {
      env = JSON.parse(m.body.toString("utf8")) as NegotiateRequest;
    } catch {
      return true;
    }
    if (env.v !== 1 || env.kind !== "negotiate_request") return true;
    if (typeof env.from !== "string" || env.from.length !== 64) return true;
    if (!env.from.startsWith(m.from.slice(0, 28))) {
      this.log(`drop spoofed negotiate_request`);
      return true;
    }

    await this.handleNegotiate(env);
    return true;
  }

  private async handleNegotiate(req: NegotiateRequest): Promise<void> {
    const tierPrice = pickTierPrice(req.sku, req.n_buyers);
    let resp: NegotiateResponse;

    if (tierPrice == null) {
      this.log(`negotiate_req from=${short(req.from)} sku=${req.sku} — DECLINE (sku not offered)`);
      resp = {
        v: 1,
        kind: "negotiate_response",
        from: this.myPeerId,
        commitment: req.commitment,
        sku: req.sku,
        n_buyers: req.n_buyers,
        unit_qty: req.unit_qty,
        decline_reason: "sku_not_offered",
      };
    } else if (tierPrice > req.max_unit_price) {
      this.log(`negotiate_req from=${short(req.from)} sku=${req.sku} n=${req.n_buyers} — DECLINE (tier $${tierPrice} > max $${req.max_unit_price})`);
      resp = {
        v: 1,
        kind: "negotiate_response",
        from: this.myPeerId,
        commitment: req.commitment,
        sku: req.sku,
        n_buyers: req.n_buyers,
        unit_qty: req.unit_qty,
        decline_reason: "tier_above_max",
      };
    } else {
      const unitsTotal = req.unit_qty * req.n_buyers;
      this.log(`negotiate_req from=${short(req.from)} sku=${req.sku} n=${req.n_buyers} qty=${req.unit_qty} — OFFER $${tierPrice}/unit (${unitsTotal} units total)`);
      resp = {
        v: 1,
        kind: "negotiate_response",
        from: this.myPeerId,
        commitment: req.commitment,
        sku: req.sku,
        n_buyers: req.n_buyers,
        unit_qty: req.unit_qty,
        tier_unit_price: tierPrice,
        valid_until_ms: Date.now() + this.offerValidForMs,
      };
    }

    try {
      await this.axl.send(req.from, JSON.stringify(resp));
      this.log(`  -> response to ${short(req.from)}`);
    } catch (e) {
      this.log(`  ! response failed: ${(e as Error).message}`);
    }
  }
}

function short(id: string): string {
  return id.slice(0, 12) + "…";
}
