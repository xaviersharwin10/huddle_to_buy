import { createServer } from "http";
import fs from "fs";
import path from "path";
import {
  verifyQuotePayment,
  QUOTE_FEE_UNITS,
  type SellerChainConfig,
} from "./chain.js";
import { GossipSub, DEFAULT_GOSSIP_CONFIG } from "./gossipsub.js";
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
  "claude-pro-subscription": [
    { minBuyers: 1,  unitPrice: 20.00 },
    { minBuyers: 3,  unitPrice: 17.00 },
    { minBuyers: 10, unitPrice: 14.00 },
  ],
  "chatgpt-plus-subscription": [
    { minBuyers: 1,  unitPrice: 20.00 },
    { minBuyers: 3,  unitPrice: 17.00 },
    { minBuyers: 10, unitPrice: 14.00 },
  ],
  "midjourney-subscription": [
    { minBuyers: 1,  unitPrice: 10.00 },
    { minBuyers: 3,  unitPrice: 8.50 },
    { minBuyers: 10, unitPrice: 7.00 },
  ],
  "cursor-pro-subscription": [
    { minBuyers: 1,  unitPrice: 20.00 },
    { minBuyers: 3,  unitPrice: 16.00 },
    { minBuyers: 10, unitPrice: 13.00 },
  ],
  "notion-ai-subscription": [
    { minBuyers: 1,  unitPrice: 10.00 },
    { minBuyers: 3,  unitPrice: 8.50 },
    { minBuyers: 10, unitPrice: 7.00 },
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
  private gossip!: GossipSub;
  private readonly paymentsFile = path.join(process.cwd(), "used_payments.json");
  private usedPayments: Set<string>;

  constructor(
    private readonly axl: AxlClient,
    private readonly log: (s: string) => void = console.log,
    private readonly offerValidForMs = 30 * 60 * 1000,
  ) {
    this.usedPayments = this.loadPayments();
  }

  private loadPayments(): Set<string> {
    try {
      if (fs.existsSync(this.paymentsFile)) {
        return new Set<string>(JSON.parse(fs.readFileSync(this.paymentsFile, "utf8")));
      }
    } catch {}
    return new Set<string>();
  }

  private markPaymentUsed(txHash: string): void {
    this.usedPayments.add(txHash);
    try {
      fs.writeFileSync(this.paymentsFile, JSON.stringify([...this.usedPayments]));
    } catch (e) {
      this.log(`WARNING: failed to persist used_payments: ${(e as Error).message}`);
    }
  }

  async init(): Promise<void> {
    const t = await this.axl.topology();
    this.myPeerId = t.our_public_key;
    
    this.gossip = new GossipSub(
      DEFAULT_GOSSIP_CONFIG,
      this.myPeerId,
      async (dest: string, data: string) => {
        try { await this.axl.send(dest, data); } catch (e) {}
      },
      async (topic: string, data: Buffer) => {
        if (topic === "huddle") {
          await this.handleEnvelopeBuffer(data, "gossip");
        }
      }
    );
    this.gossip.subscribe("huddle");

    this.log(`seller init: pubkey=${this.myPeerId}`);
    const skus = Object.keys(TIER_CARD).join(", ");
    this.log(`seller offers SKUs: ${skus}`);
  }

  async runOnce(): Promise<boolean> {
    if (this.gossip) {
      const t = await this.axl.topology();
      for (const p of t.tree.map((n) => n.public_key)) this.gossip.add_peer(p);
      this.gossip.tick();
    }

    const m = await this.axl.recv();
    if (!m) return false;

    if (this.gossip) {
      const isGossip = await this.gossip.handle_raw(m.from, m.body);
      if (isGossip) return true;
    }

    return this.handleEnvelopeBuffer(m.body, m.from);
  }

  private async handleEnvelopeBuffer(body: Buffer, transportFrom: string): Promise<boolean> {
    let env: NegotiateRequest;
    try {
      env = JSON.parse(body.toString("utf8")) as NegotiateRequest;
    } catch {
      return true;
    }
    if (env.v !== 1 || env.kind !== "negotiate_request") return true;
    if (typeof env.from !== "string" || env.from.length !== 64) return true;
    if (transportFrom !== "gossip" && !env.from.startsWith(transportFrom.slice(0, 28))) {
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

    if (this.gossip) {
      await this.gossip.publish("huddle", Buffer.from(JSON.stringify(resp)));
      this.log(`  -> negotiate_resp published via GossipSub`);
    } else {
      try {
        await this.axl.send(req.from, JSON.stringify(resp));
        this.log(`  -> response to ${short(req.from)}`);
      } catch (e) {
        this.log(`  ! response failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Starts the combined status + X402 quote HTTP server.
   * GET /health        → 200 {ok, peerId}
   * GET /status        → 200 {logs, peerId}
   * GET /quote?...     → 402 payment-required  OR  200 {tier_unit_price, ...}
   *
   * X402 flow:
   *   1. Client calls /quote without X-Payment → gets 402 + payment details.
   *   2. Client sends 0.01 MockUSDC to sellerAddress on-chain.
   *   3. Client retries with header: X-Payment: base64(JSON{txHash}).
   *   4. Seller verifies Transfer event on-chain → returns tier price.
   */
  startHttpServer(port: number, cfg: SellerChainConfig | null): void {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname === "/health") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, peerId: this.myPeerId }));
        return;
      }

      if (url.pathname === "/status") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, peerId: this.myPeerId }));
        return;
      }

      if (url.pathname !== "/quote") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const sku          = url.searchParams.get("sku") ?? "";
      const nBuyers      = parseInt(url.searchParams.get("n_buyers") ?? "0");
      const unitQty      = parseInt(url.searchParams.get("unit_qty") ?? "0");
      const maxUnitPrice = parseFloat(url.searchParams.get("max_unit_price") ?? "0");

      if (!sku || !nBuyers || !unitQty || !maxUnitPrice) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing params: sku, n_buyers, unit_qty, max_unit_price" }));
        return;
      }

      if (!cfg) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "seller not configured for X402 (set RPC_URL, PAY_TOKEN_ADDRESS, SELLER_ADDRESS)" }));
        return;
      }

      const xPaymentHeader = req.headers["x-payment"] as string | undefined;

      if (!xPaymentHeader) {
        // ── Step 1: respond 402 with payment requirements ──────────────────
        const body = {
          x402Version: 1,
          error: "Payment required for price quote",
          accepts: [{
            scheme: "exact",
            network: `gensyn-testnet-${685685}`,
            maxAmountRequired: QUOTE_FEE_UNITS.toString(),
            asset: cfg.payTokenAddress,
            payTo: cfg.sellerAddress,
            resource: "/quote",
            description: `Quote fee: 0.01 MockUSDC for ${sku} (${nBuyers} buyers)`,
          }],
        };
        res.writeHead(402);
        res.end(JSON.stringify(body));
        this.log(`x402: 402 → /quote sku=${sku} n=${nBuyers}`);
        return;
      }

      // ── Step 2: verify payment ──────────────────────────────────────────
      let txHash: `0x${string}`;
      try {
        const decoded = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8"));
        txHash = decoded?.payload?.txHash;
        if (!txHash || !txHash.startsWith("0x")) throw new Error("missing txHash");
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `invalid X-Payment header: ${(e as Error).message}` }));
        return;
      }

      if (this.usedPayments.has(txHash)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "payment already used" }));
        return;
      }

      const valid = await verifyQuotePayment({ cfg, txHash, minAmount: QUOTE_FEE_UNITS });
      if (!valid) {
        res.writeHead(402);
        res.end(JSON.stringify({ error: "on-chain payment verification failed" }));
        this.log(`x402: payment INVALID txHash=${txHash.slice(0, 10)}…`);
        return;
      }

      this.markPaymentUsed(txHash);

      // ── Step 3: return tier price ───────────────────────────────────────
      const tierPrice = pickTierPrice(sku, nBuyers);
      if (tierPrice == null) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "sku_not_offered" }));
        this.log(`x402: /quote sku=${sku} — DECLINE sku_not_offered [payment ok]`);
        return;
      }

      const validUntilMs = Date.now() + this.offerValidForMs;
      if (tierPrice > maxUnitPrice) {
        res.writeHead(200);
        res.end(JSON.stringify({ decline_reason: "tier_above_max", tier_unit_price: tierPrice, max_unit_price: maxUnitPrice }));
        this.log(`x402: /quote sku=${sku} n=${nBuyers} — DECLINE tier $${tierPrice} > max $${maxUnitPrice} [payment ok]`);
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ tier_unit_price: tierPrice, valid_until_ms: validUntilMs, sku, n_buyers: nBuyers, unit_qty: unitQty }));
      this.log(`x402: /quote sku=${sku} n=${nBuyers} — OFFER $${tierPrice}/unit [txHash=${txHash.slice(0, 10)}…]`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.log(`WARNING: port ${port} already in use — X402 server not started`);
      } else {
        this.log(`X402 server error: ${err.message}`);
      }
    });

    server.listen(port, () => {
      this.log(`x402: seller quote server on http://localhost:${port}/quote`);
    });
  }
}

function short(id: string): string {
  return id.slice(0, 12) + "…";
}
