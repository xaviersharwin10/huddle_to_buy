import { GossipSub, DEFAULT_GOSSIP_CONFIG } from "./gossipsub.js";
import { AxlClient } from "./axl.js";
import type {
  CoalitionReadyEnv,
  CommitEnv,
  Envelope,
  NegotiateReqEnv,
  NegotiateRespEnv,
  RevealReqEnv,
  RevealRespEnv,
} from "./envelope.js";
import {
  createOnchainConfigFromEnv,
  createZeroGProfileConfigFromEnv,
  deployCoalition,
  fundCoalitionForBuyer,
  mintBuyerProfile0G,
  sealCoalitionInference,
  sendQuotePayment,
  toTokenUnits,
  type OnchainConfig,
  type ZeroGProfileConfig,
} from "./chain.js";
import { canonicalSku, commitment, type Intent, newNonce } from "./intent.js";
import { keccak256, toHex } from "viem";
import { IntentObserver } from "./observer.js";
import {
  createZeroGStorageConfigFromEnv,
  uploadProfileBlob,
  writeCoalitionKv,
  type ZeroGStorageConfig,
} from "./zerog-storage.js";

export type ClusterState = {
  commitment: string;
  members: Map<string, Intent>;
  coordinator?: string;
  formed: boolean;
  // Day-4 negotiation state:
  negotiateSent?: boolean;
  offer?: { tierUnitPrice: number; validUntilMs: number };
  coalitionAddress?: `0x${string}`;
  fundedByMe?: boolean;
  declinedReason?: string;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  // Tech-stack proof hashes (surfaced to UI for judge demo):
  x402TxHash?: string;
  fundTx?: string;
  zeroGSealTx?: string;
};

type Logger = (s: string) => void;

export type HuddleAgentOptions = {
  k?: number;
  sellerPeerId?: string | null;
  /** HTTP base URL of the seller's X402 quote server (e.g. http://127.0.0.1:3004). */
  sellerApi?: string | null;
  /** Optional override for broadcast peers. If null, falls back to /topology.tree. */
  knownPeers?: string[] | null;
  /** Map of peer pubkey → HTTP base URL for direct HTTP peer messaging.
   *  When set, GossipSub sends go via HTTP POST /peer-msg instead of axl.send(),
   *  bypassing the Yggdrasil transport which doesn't work in single-container Railway. */
  peerUrlMap?: Map<string, string>;
  onchain?: OnchainConfig | null;
  autoFund?: boolean;
  fundDelayMs?: number;
  log?: Logger;
};

export class HuddleAgent {
  private observer: IntentObserver;
  private gossip!: GossipSub;
  private myCommits = new Map<string, { intent: Intent; nonce: string }>();
  private clusters = new Map<string, ClusterState>();
  private revealsInitiated = new Set<string>();
  myPeerId = "";

  private readonly k: number;
  private readonly sellerPeerId: string | null;
  private readonly sellerApi: string | null;
  private readonly knownPeers: string[] | null;
  private readonly onchain: OnchainConfig | null;
  private readonly zeroGProfile: ZeroGProfileConfig | null;
  private readonly zeroGStorage: ZeroGStorageConfig | null;
  private myTokenId: bigint | null = null;
  private readonly autoFund: boolean;
  private readonly fundDelayMs: number;
  private readonly log: Logger;
  private readonly peerUrlMap: Map<string, string>;

  constructor(private readonly axl: AxlClient, opts: HuddleAgentOptions = {}) {
    this.k = opts.k ?? 3;
    this.sellerPeerId = opts.sellerPeerId ?? null;
    this.sellerApi = opts.sellerApi ?? null;
    this.knownPeers = opts.knownPeers ?? null;
    this.peerUrlMap = opts.peerUrlMap ?? new Map();
    this.onchain = opts.onchain ?? createOnchainConfigFromEnv();
    this.zeroGProfile = createZeroGProfileConfigFromEnv();
    this.zeroGStorage = createZeroGStorageConfigFromEnv();
    this.autoFund = opts.autoFund ?? true;
    this.fundDelayMs = opts.fundDelayMs ?? 0;
    this.log = opts.log ?? console.log;
    this.observer = new IntentObserver(24 * 60 * 60 * 1000, this.k);
  }

  /** Called by the HTTP server when a peer POSTs to /peer-msg. */
  public async injectPeerMessage(body: Buffer, from: string): Promise<void> {
    if (this.gossip) {
      const isGossip = await this.gossip.handle_raw(from, body);
      if (isGossip) return;
    }
    await this.handleEnvelopeBuffer(body, from);
  }

  private async broadcastPeers(): Promise<string[]> {
    if (this.knownPeers && this.knownPeers.length > 0) {
      return this.knownPeers.filter(
        (p) => p !== this.myPeerId && p !== this.sellerPeerId,
      );
    }
    return (await this.axl.peerIds()).filter((p) => p !== this.sellerPeerId);
  }

  async init(): Promise<void> {
    const t = await this.axl.topology();
    this.myPeerId = t.our_public_key;
    this.log(`agent init: pubkey=${short(this.myPeerId)}${this.sellerPeerId ? `  seller=${short(this.sellerPeerId)}` : ""}`);

    this.gossip = new GossipSub(
      DEFAULT_GOSSIP_CONFIG,
      this.myPeerId,
      async (dest: string, data: string) => {
        // Prefer HTTP peer send (bypasses Yggdrasil which doesn't work in
        // single-container deployments); fall back to AXL for local dev.
        const url = this.peerUrlMap.get(dest);
        if (url) {
          try {
            await fetch(`${url}/peer-msg`, {
              method: "POST",
              headers: { "x-from-peer-id": this.myPeerId, "content-type": "application/json" },
              body: data,
            });
            return;
          } catch {}
        }
        try { await this.axl.send(dest, data); } catch {}
      },
      async (topic: string, data: Buffer) => {
        if (topic === "huddle") {
          await this.handleEnvelopeBuffer(data, "gossip");
        }
      }
    );
    this.gossip.subscribe("huddle");
    
    if (this.onchain) {
      this.log(
        `onchain: enabled chain=${this.onchain.chainId} factory=${shortAddr(this.onchain.factoryAddress)} token=${shortAddr(this.onchain.payTokenAddress)}`,
      );
      this.log(`onchain: autoFund=${this.autoFund} fundDelayMs=${this.fundDelayMs}`);
    } else {
      this.log(
        "onchain: disabled (set RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, KEEPER_ADDRESS, SELLER_ADDRESS, PAY_TOKEN_ADDRESS)",
      );
    }

    // 0G Buyer Profile iNFT mint (best-effort; only when fully configured).
    if (this.zeroGProfile) {
      try {
        // Build agent preference blob — this is the data stored in 0G Storage.
        const prefJson = JSON.stringify({
          agentId: this.myPeerId,
          chain: "huddle-v1",
          network: "gensyn-testnet-685685",
          timestamp: Date.now(),
        });
        const prefBuf = Buffer.from(prefJson, "utf8");

        // Attempt real 0G Storage upload; fall back to content-addressed URI.
        let storageUri: string;
        if (this.zeroGStorage) {
          try {
            const uri = await uploadProfileBlob(this.zeroGStorage, prefBuf);
            storageUri = uri ?? `0g://huddle-buyer/v1/${keccak256(toHex(prefJson))}`;
            this.log(`0G Storage: profile blob uploaded → ${storageUri}`);
          } catch (e) {
            storageUri = `0g://huddle-buyer/v1/${keccak256(toHex(prefJson))}`;
            this.log(`0G Storage: upload skipped (${(e as Error).message}) → ${storageUri}`);
          }
        } else {
          storageUri = `0g://huddle-buyer/v1/${keccak256(toHex(prefJson))}`;
          this.log(`0G Storage: skipped (set ZEROG_FLOW_ADDRESS to enable) → ${storageUri}`);
        }

        // Stagger mints by port so buyers sharing a ZEROG key don't submit
        // the same nonce simultaneously (PORT 3001→0s, 3002→12s, 3003→24s).
        const agentPort = Number(process.env.PORT ?? "3001");
        const mintDelay = Math.max(0, agentPort - 3001) * 12_000;
        if (mintDelay > 0) {
          this.log(`0G iNFT: staggering mint by ${mintDelay / 1000}s to avoid nonce conflict`);
          await new Promise<void>((r) => setTimeout(r, mintDelay));
        }

        const result = await mintBuyerProfile0G(this.zeroGProfile, storageUri);
        if (result) {
          this.myTokenId = result.tokenId;
          if (result.txHash) {
            this.log(`0G iNFT: mintProfile tx=${result.txHash} tokenId=${result.tokenId} uri=${storageUri}`);
          } else {
            this.log(`0G iNFT: using existing profile tokenId=${result.tokenId} (already minted)`);
          }
        } else {
          this.log("0G iNFT: skipped (no profile found for this address)");
        }
      } catch (e) {
        this.log(`0G iNFT mint failed: ${(e as Error).message}`);
      }
    } else {
      this.log("0G iNFT: skipped (set BUYER_PROFILE_ADDRESS + ZEROG_PRIVATE_KEY to mint)");
    }
  }

  getUIStatus() {
    const statuses: any[] = [];
    for (const [c, commit] of this.myCommits.entries()) {
      const cluster = this.clusters.get(c);
      let statusString = "Broadcasting Intent";
      if (cluster) {
         if (cluster.formed) statusString = "Negotiating Tier Price";
         if (cluster.offer) statusString = "Tier Offer Received";
         if (cluster.coalitionAddress) statusString = "Deploying Coalition";
         if (cluster.fundedByMe) statusString = "Settled (commit ready)";
         if (cluster.declinedReason) statusString = `Declined: ${cluster.declinedReason}`;
      }
      statuses.push({
         commitment: short(c),
         sku: commit.intent.sku,
         qty: commit.intent.qty,
         max_unit_price: commit.intent.max_unit_price,
         deadline_ms: commit.intent.deadline_ms,
         statusStr: statusString,
         clusterSize: cluster ? cluster.members.size : 1,
         offer: cluster?.offer,
         address: cluster?.coalitionAddress || null,
         x402TxHash: cluster?.x402TxHash || null,
         fundTx: cluster?.fundTx || null,
         zeroGSealTx: cluster?.zeroGSealTx || null,
      });
    }
    return {
      peerId: this.myPeerId,
      myCommits: statuses,
    };
  }

  async submit(intent: Intent): Promise<string> {
    const c = commitment(intent);
    const nonce = newNonce();
    this.myCommits.set(c, { intent, nonce });
    this.observer.observe(c, this.myPeerId);
    this.log(`submit ${JSON.stringify(intent)}  c=${short(c)}`);

    const env: CommitEnv = { v: 1, kind: "commit", from: this.myPeerId, commitment: c };
    const body = Buffer.from(JSON.stringify(env));
    
    if (this.gossip) {
       await this.gossip.publish("huddle", body);
       this.log(`  -> commit published via GossipSub to c=${short(c)}`);
    } else {
      const peers = await this.broadcastPeers();
      for (const p of peers) {
        try { await this.axl.send(p, JSON.stringify(env)); this.log(`  -> commit to ${short(p)}`); }
        catch (e) { this.log(`  ! commit to ${short(p)} failed: ${(e as Error).message}`); }
      }
    }
    return c;
  }

  async runOnce(): Promise<boolean> {
    if (this.gossip) {
       const peers = await this.broadcastPeers();
       for (const p of peers) this.gossip.add_peer(p);
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
    let env: Envelope;
    try {
      env = JSON.parse(body.toString("utf8")) as Envelope;
    } catch {
      this.log(`drop non-json from ${short(transportFrom)}`);
      return true;
    }
    if (env.v !== 1) return true;
    if (typeof env.from !== "string" || env.from.length !== 64) {
      this.log(`drop bad-from envelope`);
      return true;
    }
    // We can't spoof-check gossip messages easily via transportFrom if they hopped through others.
    if (transportFrom !== "gossip" && !env.from.startsWith(transportFrom.slice(0, 28))) {
      this.log(`drop spoofed envelope (claim=${short(env.from)} transport=${short(transportFrom)})`);
      return true;
    }

    switch (env.kind) {
      case "commit":             await this.onCommit(env); break;
      case "reveal_request":     await this.onRevealRequest(env); break;
      case "reveal_response":    await this.onRevealResponse(env); break;
      case "negotiate_request":  this.log(`drop negotiate_request — buyer agent doesn't sell`); break;
      case "negotiate_response": await this.onNegotiateResponse(env); break;
      case "coalition_ready":    await this.onCoalitionReady(env); break;
    }
    return true;
  }

  private async onCommit(env: CommitEnv): Promise<void> {
    const r = this.observer.observe(env.commitment, env.from);
    this.log(`recv commit from=${short(env.from)} c=${short(env.commitment)} distinct=${r.count}`);
    if (
      r.thresholdReached &&
      this.myCommits.has(env.commitment) &&
      !this.revealsInitiated.has(env.commitment)
    ) {
      this.revealsInitiated.add(env.commitment);
      await this.initiateReveals(env.commitment);
    }
  }

  private async initiateReveals(c: string): Promise<void> {
    const my = this.myCommits.get(c)!;
    const peers = this.observer.peersFor(c).filter((p) => p !== this.myPeerId);
    this.log(`*** k=${this.k} threshold for ${short(c)} — initiating reveal to ${peers.length} peer(s) ***`);

    const cluster = this.cluster(c);
    cluster.members.set(this.myPeerId, my.intent);

    const env: RevealReqEnv = {
      v: 1, kind: "reveal_request", from: this.myPeerId,
      commitment: c, intent: my.intent, nonce: my.nonce,
    };
    
    if (this.gossip) {
      await this.gossip.publish("huddle", Buffer.from(JSON.stringify(env)));
      this.log(`  -> reveal_req published via GossipSub`);
    } else {
      const body = JSON.stringify(env);
      for (const p of peers) {
        try { await this.axl.send(p, body); this.log(`  -> reveal_req to ${short(p)}`); }
        catch (e) { this.log(`  ! reveal_req to ${short(p)} failed: ${(e as Error).message}`); }
      }
    }
    await this.maybeFinalize(c);
  }

  private async onRevealRequest(env: RevealReqEnv): Promise<void> {
    if (commitment(env.intent) !== env.commitment) {
      this.log(`drop reveal_request from ${short(env.from)} — hash mismatch`);
      return;
    }
    this.log(`reveal_req from ${short(env.from)} c=${short(env.commitment)} intent=${JSON.stringify(env.intent)}`);

    const cluster = this.cluster(env.commitment);
    cluster.members.set(env.from, env.intent);

    const my = this.myCommits.get(env.commitment);
    if (my) {
      cluster.members.set(this.myPeerId, my.intent);
      const resp: RevealRespEnv = {
        v: 1, kind: "reveal_response", from: this.myPeerId,
        commitment: env.commitment, intent: my.intent, nonce: my.nonce,
      };
      
      if (this.gossip) {
        await this.gossip.publish("huddle", Buffer.from(JSON.stringify(resp)));
        this.log(`  -> reveal_resp published via GossipSub`);
      } else {
        try { await this.axl.send(env.from, JSON.stringify(resp)); this.log(`  -> reveal_resp to ${short(env.from)}`); }
        catch (e) { this.log(`  ! reveal_resp to ${short(env.from)} failed: ${(e as Error).message}`); }
      }
    }
    await this.maybeFinalize(env.commitment);
  }

  private async onRevealResponse(env: RevealRespEnv): Promise<void> {
    if (commitment(env.intent) !== env.commitment) {
      this.log(`drop reveal_response from ${short(env.from)} — hash mismatch`);
      return;
    }
    this.log(`reveal_resp from ${short(env.from)} c=${short(env.commitment)}`);
    const cluster = this.cluster(env.commitment);
    cluster.members.set(env.from, env.intent);
    await this.maybeFinalize(env.commitment);
  }

  private async maybeFinalize(c: string): Promise<void> {
    const cluster = this.clusters.get(c);
    if (!cluster || cluster.formed) return;
    if (cluster.members.size < this.k) return;

    const sorted = [...cluster.members.keys()].sort();
    cluster.coordinator = sorted[0];
    cluster.formed = true;
    const isMe = cluster.coordinator === this.myPeerId;
    this.log(`*** CLUSTER FORMED c=${short(c)} ${cluster.members.size} members ${isMe ? "(I am coordinator)" : `(coordinator: ${short(cluster.coordinator)})`} ***`);
    for (const p of sorted) {
      const intent = cluster.members.get(p)!;
      this.log(`    member ${short(p)}  qty=${intent.qty}  max=$${intent.max_unit_price}`);
    }

    if (isMe) await this.tryNegotiate(c);

    // Arm fallback: the second lex peer takes over if no coalition_ready arrives in 30s.
    // All agents agree on who the fallback is deterministically — no extra messages needed.
    const isFallback = sorted.length >= 2 && sorted[1] === this.myPeerId;
    if (isFallback) {
      cluster.fallbackTimer = setTimeout(async () => {
        if (!cluster.coalitionAddress) {
          this.log(`*** FALLBACK coordinator timeout for c=${short(c)} — taking over from ${short(sorted[0])} ***`);
          cluster.coordinator = this.myPeerId;
          cluster.negotiateSent = false;
          await this.tryNegotiate(c);
        }
      }, 30_000);
      this.log(`fallback: 30s timer armed for c=${short(c)} (primary=${short(sorted[0])})`);
    }
  }

  private async tryNegotiate(c: string): Promise<void> {
    const cluster = this.clusters.get(c)!;
    if (cluster.negotiateSent || (!this.sellerPeerId && !this.sellerApi)) {
      if (!this.sellerPeerId && !this.sellerApi)
        this.log(`(no SELLER_PEER_ID/SELLER_API set — skipping negotiate)`);
      return;
    }
    cluster.negotiateSent = true;

    // COORDINATOR_CRASH_TEST=true: primary coordinator stalls before negotiating,
    // letting the 30s fallback timer fire reliably for Scenario 2 demo/testing.
    const crashTest = (process.env.COORDINATOR_CRASH_TEST ?? "false").toLowerCase() === "true";
    if (crashTest && cluster.coordinator === this.myPeerId) {
      this.log(`[crash-test] primary coordinator stalling — fallback should take over in 30s`);
      await sleep(60_000);
    }

    // Try X402 HTTP first — pays 0.01 MockUSDC and gets tier price back directly.
    if (this.sellerApi) {
      const ok = await this.negotiateViaX402(c, this.sellerApi);
      if (ok) return;
      this.log(`x402: negotiation failed — falling back to GossipSub`);
    }

    // GossipSub fallback (original path).
    if (!this.sellerPeerId) return;
    const sample = [...cluster.members.values()][0];
    const req: NegotiateReqEnv = {
      v: 1,
      kind: "negotiate_request",
      from: this.myPeerId,
      commitment: c,
      sku: sample.sku,
      n_buyers: cluster.members.size,
      unit_qty: sample.qty,
      max_unit_price: sample.max_unit_price,
    };
    this.log(`coordinator: negotiate_request → seller ${short(this.sellerPeerId)} (n=${req.n_buyers}, max=$${req.max_unit_price})`);

    if (this.gossip) {
      try { await this.axl.send(this.sellerPeerId, JSON.stringify(req)); } catch (_) {}
      await this.gossip.publish("huddle", Buffer.from(JSON.stringify(req)));
      this.log(`  -> negotiate_req published via GossipSub`);
    } else {
      try { await this.axl.send(this.sellerPeerId, JSON.stringify(req)); }
      catch (e) { this.log(`  ! negotiate_request failed: ${(e as Error).message}`); }
    }
  }

  /**
   * X402 negotiation: coordinator pays 0.01 MockUSDC to the seller's HTTP
   * /quote endpoint, receives a tier price, and proceeds directly to coalition
   * deployment — no GossipSub round-trip required.
   */
  private async negotiateViaX402(c: string, sellerApi: string): Promise<boolean> {
    const cluster = this.clusters.get(c)!;
    const sample = [...cluster.members.values()][0];

    const params = new URLSearchParams({
      sku: sample.sku,
      n_buyers: String(cluster.members.size),
      unit_qty: String(sample.qty),
      max_unit_price: String(sample.max_unit_price),
    });
    const quoteUrl = `${sellerApi}/quote?${params}`;

    try {
      // ── Step 1: initial request → expect 402 ─────────────────────────────
      this.log(`x402: GET ${quoteUrl}`);
      const res1 = await fetch(quoteUrl);
      if (res1.status !== 402) {
        this.log(`x402: unexpected status ${res1.status} (expected 402)`);
        return false;
      }

      const payReq = (await res1.json()) as any;
      const accept = payReq?.accepts?.[0];
      if (!accept?.payTo || !accept?.asset) {
        this.log(`x402: malformed 402 response`);
        return false;
      }

      if (!this.onchain) {
        this.log(`x402: onchain disabled — cannot pay quote fee`);
        return false;
      }

      // ── Step 2: pay the quote fee on-chain ───────────────────────────────
      this.log(`x402: paying ${accept.maxAmountRequired} token units → ${accept.payTo}`);
      const txHash = await sendQuotePayment({
        cfg: this.onchain,
        recipientAddress: accept.payTo as `0x${string}`,
      });
      this.log(`x402: payment confirmed txHash=${txHash}`);
      cluster.x402TxHash = txHash;

      // ── Step 3: retry with X-Payment proof ───────────────────────────────
      const xPayment = Buffer.from(
        JSON.stringify({ x402Version: 1, scheme: "exact", network: `gensyn-testnet-${this.onchain.chainId}`, payload: { txHash } }),
      ).toString("base64");

      const res2 = await fetch(quoteUrl, { headers: { "X-Payment": xPayment } });
      if (!res2.ok) {
        const body = await res2.text();
        this.log(`x402: quote rejected after payment (${res2.status}): ${body}`);
        return false;
      }

      const quote = (await res2.json()) as any;
      if (quote.decline_reason) {
        this.log(`x402: seller declined: ${quote.decline_reason}`);
        cluster.declinedReason = quote.decline_reason;
        return false;
      }

      const tierUnitPrice: number = quote.tier_unit_price;
      const validUntilMs: number  = quote.valid_until_ms;
      cluster.offer = { tierUnitPrice, validUntilMs };

      const indivPrice = sample.max_unit_price;
      const savedPerBuyer = (indivPrice - tierUnitPrice) * sample.qty;
      const totalSaved    = savedPerBuyer * cluster.members.size;
      const expiryS = Math.round((validUntilMs - Date.now()) / 1000);
      this.log(`x402: OFFER $${tierUnitPrice}/unit × ${sample.qty} × ${cluster.members.size}; saved $${savedPerBuyer.toFixed(2)}/buyer ($${totalSaved.toFixed(2)} total); valid ${expiryS}s`);

      // 0G Compute: delegate accept/reject decision to qwen/qwen-2.5-7b-instruct inference.
      const shouldAccept = await this.decide0GCompute(indivPrice, tierUnitPrice, sample.qty, cluster.members.size);
      if (!shouldAccept) {
        this.log(`0G Compute: offer rejected — AI assessed $${tierUnitPrice}/unit below threshold`);
        return false;
      }

      // Synthesise a NegotiateRespEnv so the existing coalition-deploy path is reused.
      const fakeResp: NegotiateRespEnv = {
        v: 1,
        kind: "negotiate_response",
        from: this.sellerPeerId ?? "",
        commitment: c,
        sku: sample.sku,
        n_buyers: cluster.members.size,
        unit_qty: sample.qty,
        tier_unit_price: tierUnitPrice,
        valid_until_ms: validUntilMs,
      };
      await this.maybeDeployCoalition(fakeResp);
      return true;
    } catch (e) {
      this.log(`x402: error — ${(e as Error).message}`);
      return false;
    }
  }

  private async onNegotiateResponse(env: NegotiateRespEnv): Promise<void> {
    const cluster = this.clusters.get(env.commitment);
    if (!cluster || cluster.coordinator !== this.myPeerId) {
      this.log(`drop negotiate_response — not coordinator for c=${short(env.commitment)}`);
      return;
    }
    if (env.decline_reason) {
      this.log(`*** SELLER DECLINED c=${short(env.commitment)}: ${env.decline_reason} ***`);
      cluster.declinedReason = env.decline_reason;
      return;
    }
    if (env.tier_unit_price == null || env.valid_until_ms == null) {
      this.log(`drop malformed negotiate_response`);
      return;
    }
    cluster.offer = { tierUnitPrice: env.tier_unit_price, validUntilMs: env.valid_until_ms };

    const indivPrice = [...cluster.members.values()][0].max_unit_price;
    const savedPerBuyer = (indivPrice - env.tier_unit_price) * env.unit_qty;
    const totalSaved = savedPerBuyer * env.n_buyers;
    const expiryS = Math.round((env.valid_until_ms - Date.now()) / 1000);
    this.log(`*** SELLER OFFER c=${short(env.commitment)}: $${env.tier_unit_price}/unit × ${env.unit_qty} × ${env.n_buyers}; saved $${savedPerBuyer.toFixed(2)}/buyer ($${totalSaved.toFixed(2)} total); valid ${expiryS}s ***`);

    await this.maybeDeployCoalition(env);
  }

  private async maybeDeployCoalition(env: NegotiateRespEnv): Promise<void> {
    const cluster = this.clusters.get(env.commitment);
    if (!cluster || cluster.coordinator !== this.myPeerId) return;
    if (cluster.coalitionAddress) return;
    if (!this.onchain) {
      this.log("(onchain disabled — skipping coalition deployment)");
      return;
    }

    const skuHash = keccak256(toHex(canonicalSku(env.sku)));
    try {
      const coalitionAddress = await deployCoalition({
        cfg: this.onchain,
        skuHash,
        tierUnitPrice: toTokenUnits(env.tier_unit_price!, this.onchain.payTokenDecimals),
        unitQty: env.unit_qty,
        requiredBuyers: env.n_buyers,
        validUntilMs: env.valid_until_ms!,
      });

      cluster.coalitionAddress = coalitionAddress;
      this.log(`*** COALITION DEPLOYED c=${short(env.commitment)}: ${coalitionAddress} ***`);

      const ready: CoalitionReadyEnv = {
        v: 1,
        kind: "coalition_ready",
        from: this.myPeerId,
        commitment: env.commitment,
        coalition_address: coalitionAddress,
        chain_id: this.onchain.chainId,
        tier_unit_price: cluster.offer?.tierUnitPrice,
      };

      if (this.gossip) {
        await this.gossip.publish("huddle", Buffer.from(JSON.stringify(ready)));
        this.log(`  -> coalition_ready published via GossipSub to c=${short(env.commitment)}`);
      } else {
        for (const peer of cluster.members.keys()) {
          if (peer === this.myPeerId) continue;
          try {
            await this.axl.send(peer, JSON.stringify(ready));
            this.log(`  -> coalition_ready to ${short(peer)}`);
          } catch (e) {
            this.log(`  ! coalition_ready to ${short(peer)} failed: ${(e as Error).message}`);
          }
        }
      }

      // AXL MCP: notify the seller's order-book service via the P2P mesh using
      // the full AXL MCP transport layer (/mcp/{peer}/{service}).
      if (this.sellerPeerId) {
        try {
          const mcpReq = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "record_coalition",
              arguments: {
                coalition_address: coalitionAddress,
                sku: env.sku,
                n_buyers: env.n_buyers,
                chain_id: this.onchain.chainId,
              },
            },
          };
          const mcpRes = await this.axl.mcp(this.sellerPeerId, "order-book", mcpReq);
          this.log(`AXL MCP: /mcp/${short(this.sellerPeerId)}/order-book → ${JSON.stringify(mcpRes).slice(0, 120)}`);
        } catch (e) {
          this.log(`AXL MCP: /mcp/${short(this.sellerPeerId)}/order-book call failed (${(e as Error).message})`);
        }
      }

      await this.maybeFundCoalition(env.commitment, coalitionAddress);
    } catch (e) {
      this.log(`  ! coalition deployment failed: ${(e as Error).message}`);
    }
  }

  private async onCoalitionReady(env: CoalitionReadyEnv): Promise<void> {
    const cluster = this.clusters.get(env.commitment);
    if (!cluster) {
      this.log(`drop coalition_ready c=${short(env.commitment)} — unknown cluster`);
      return;
    }

    // Accept from the elected coordinator OR the designated fallback (second lex peer).
    // The fallback may have taken over if the primary timed out.
    const sorted = [...cluster.members.keys()].sort();
    const isAcceptable =
      !cluster.coordinator ||
      env.from === cluster.coordinator ||
      (sorted.length >= 2 && env.from === sorted[1]);
    if (!isAcceptable) {
      this.log(`drop coalition_ready c=${short(env.commitment)} — unexpected sender ${short(env.from)}`);
      return;
    }

    // Cancel fallback timer — whoever sent coalition_ready succeeded.
    if (cluster.fallbackTimer) {
      clearTimeout(cluster.fallbackTimer);
      cluster.fallbackTimer = undefined;
    }
    cluster.coordinator = env.from;

    cluster.coalitionAddress = env.coalition_address;
    if (env.tier_unit_price != null && !cluster.offer) {
      cluster.offer = { tierUnitPrice: env.tier_unit_price, validUntilMs: Date.now() + 30 * 60 * 1000 };
    }
    this.log(`coalition_ready c=${short(env.commitment)} addr=${env.coalition_address} chain=${env.chain_id}`);
    await this.maybeFundCoalition(env.commitment, env.coalition_address);
  }

  private async maybeFundCoalition(
    commitmentKey: string,
    coalitionAddress: `0x${string}`,
  ): Promise<void> {
    const cluster = this.clusters.get(commitmentKey);
    if (!cluster || !cluster.members.has(this.myPeerId)) return;
    if (cluster.fundedByMe) return;
    if (!this.onchain) {
      this.log("(onchain disabled — skipping fund)");
      return;
    }
    if (!this.autoFund) {
      this.log("(AUTO_FUND=false — skipping fund for drop-out replay)");
      return;
    }

    if (this.fundDelayMs > 0) {
      this.log(`fund: delaying ${this.fundDelayMs}ms before approve+fund`);
      await sleep(this.fundDelayMs);
    }

    try {
      const { approveTx, fundTx } = await fundCoalitionForBuyer({
        cfg: this.onchain,
        coalitionAddress,
      });
      if (approveTx) {
        this.log(`fund: approve tx=${approveTx}`);
      }
      this.log(`fund: success tx=${fundTx}`);
      cluster.fundedByMe = true;
      cluster.fundTx = fundTx;

      // Seal the coalition outcome into the buyer's 0G iNFT (best-effort).
      const sample = [...cluster.members.values()][0];
      if (this.zeroGProfile && this.myTokenId !== null) {
        try {
          // Stagger seal calls — buyers sharing ZEROG_PRIVATE_KEY would
          // otherwise submit the same nonce simultaneously.
          const sealPort = Number(process.env.PORT ?? "3001");
          const sealDelay = Math.max(0, sealPort - 3001) * 15_000;
          if (sealDelay > 0) await new Promise<void>((r) => setTimeout(r, sealDelay));

          const sealTx = await sealCoalitionInference({
            cfg: this.zeroGProfile,
            tokenId: this.myTokenId,
            coalitionAddress,
            sku: sample.sku,
          });
          this.log(`0G iNFT: sealInference tx=${sealTx} tokenId=${this.myTokenId} coalition=${coalitionAddress}`);
          cluster.zeroGSealTx = sealTx;
        } catch (e) {
          this.log(`0G iNFT sealInference failed: ${(e as Error).message}`);
        }
      }

      // Write coalition outcome to 0G KV store (best-effort).
      if (this.zeroGStorage && this.myTokenId !== null) {
        try {
          const kvTx = await writeCoalitionKv(
            this.zeroGStorage,
            coalitionAddress,
            sample.sku,
            this.myTokenId,
          );
          this.log(`0G KV: coalition outcome written txHash=${kvTx} coalition=${coalitionAddress}`);
        } catch (e) {
          this.log(`0G KV write failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log(`  ! fund failed: ${(e as Error).message}`);
    }
  }

  /**
   * Uses 0G Compute (qwen/qwen-2.5-7b-instruct) to decide whether to accept a bulk offer.
   * Falls back to a simple price comparison when ZEROG_COMPUTE_API_KEY is not set.
   */
  private async decide0GCompute(
    maxUnitPrice: number,
    offerUnitPrice: number,
    qty: number,
    nBuyers: number,
  ): Promise<boolean> {
    const apiKey = process.env.ZEROG_COMPUTE_API_KEY ?? "";
    // ZEROG_COMPUTE_URL is the provider-specific service URL from the 0G Compute
    // Marketplace (pc.0g.ai). Format: https://<provider-host>
    // The proxy path /v1/proxy/chat/completions is the 0G standard for inference.
    const apiUrl = (process.env.ZEROG_COMPUTE_URL ?? "").replace(/\/$/, "");

    if (!apiKey || !apiUrl) {
      this.log(`0G Compute: ZEROG_COMPUTE_API_KEY/ZEROG_COMPUTE_URL not set — using price comparison`);
      return offerUnitPrice <= maxUnitPrice;
    }

    const discount = ((1 - offerUnitPrice / maxUnitPrice) * 100).toFixed(1);
    const prompt =
      `You are a bulk-buying AI agent coordinating a coalition of ${nBuyers} buyers. ` +
      `A supplier offered ${qty} units at $${offerUnitPrice} each (${discount}% below your max of $${maxUnitPrice}). ` +
      `Reply with exactly one word: accept or reject.`;

    try {
      const res = await fetch(`${apiUrl}/v1/proxy/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.ZEROG_COMPUTE_MODEL ?? "qwen/qwen-2.5-7b-instruct",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 5,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        this.log(`0G Compute: HTTP ${res.status} — falling back to price comparison`);
        return offerUnitPrice <= maxUnitPrice;
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const answer = (data.choices?.[0]?.message?.content ?? "").toLowerCase().trim();
      this.log(`0G Compute: "${answer}" via ${apiUrl} (offer=$${offerUnitPrice} max=$${maxUnitPrice} discount=${discount}%)`);
      return answer.startsWith("accept");
    } catch (e) {
      this.log(`0G Compute: ${(e as Error).message} — falling back to price comparison`);
      return offerUnitPrice <= maxUnitPrice;
    }
  }

  private cluster(c: string): ClusterState {
    let cl = this.clusters.get(c);
    if (!cl) {
      cl = { commitment: c, members: new Map(), formed: false };
      this.clusters.set(c, cl);
    }
    return cl;
  }
}

function short(id: string): string {
  return id.slice(0, 12) + "…";
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
