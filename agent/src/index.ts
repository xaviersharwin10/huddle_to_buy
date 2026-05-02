import { HuddleAgent } from "./agent.js";
import { AxlClient } from "./axl.js";
import type { Intent } from "./intent.js";
import { SellerAgent } from "./seller.js";
import { createSellerChainConfigFromEnv } from "./chain.js";

// ethers v6 uses BigInt for gas/nonce; teach JSON.stringify to serialize them as strings
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const AXL = process.env.AXL_API ?? "http://127.0.0.1:9002";
const K = Number(process.env.K ?? "3");
const SELLER_PEER_ID = process.env.SELLER_PEER_ID ?? null;
const SELLER_API     = process.env.SELLER_API ?? null;
const AUTO_FUND = (process.env.AUTO_FUND ?? "true").toLowerCase() === "true";
const FUND_DELAY_MS = Number(process.env.FUND_DELAY_MS ?? "0");
const KNOWN_PEERS = (process.env.KNOWN_PEERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length === 64);

const help = `huddle-agent

env:
  AXL_API           AXL local HTTP API (default http://127.0.0.1:9002)
  K                 k-anonymity threshold (default 3)
  SELLER_PEER_ID    seller's full pubkey (64 hex). Coordinator queries this peer for tier price.
  SELLER_API        seller's X402 HTTP base URL (e.g. http://127.0.0.1:3004). Coordinator pays
                    0.01 MockUSDC via X402 to get the tier price. Falls back to GossipSub if unset.
  KNOWN_PEERS       comma-separated full pubkeys to broadcast to. Overrides /topology.tree.
                    Use this when Yggdrasil tree convergence is incomplete (hub-spoke topologies).
  RPC_URL           EVM RPC for Day-5 coalition flow (e.g. Gensyn Testnet RPC)
  CHAIN_ID          EVM chain id (default 685685 — Gensyn Testnet)
  PRIVATE_KEY       buyer/coordinator EOA used for deploy/fund txs
  FACTORY_ADDRESS   deployed CoalitionFactory address
  KEEPER_ADDRESS    keeper EOA authorized to call commit/refund
  SELLER_ADDRESS    seller treasury address for committed payout
  PAY_TOKEN_ADDRESS ERC20 payment token address (MockUSDC on Gensyn Testnet)
  PAY_TOKEN_DECIMALS ERC20 decimals (default 6)
  AUTO_FUND         auto-approve and fund coalition on coalition_ready (default true)
  FUND_DELAY_MS     optional delay before fund tx, useful for replay timing tests

commands:
  topology
  run [<sku> <max_unit_price> <deadline_hours> <qty>]    submit (optional) + watch as buyer/coordinator
  seller                                                  run as seller — listen for negotiate_request, respond with tier price
`;

const STREAM_LOGS: string[] = [];
const originalConsLog = console.log;
console.log = (...args: any[]) => {
   const ts = new Date().toISOString().substring(11, 23);
   const line = `[${ts}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(" ");
   STREAM_LOGS.push(line);
   if (STREAM_LOGS.length > 50) STREAM_LOGS.shift();
   originalConsLog(...args);
};

export function getStreamLogs() {
  return STREAM_LOGS;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const axl = new AxlClient(AXL);

  switch (cmd) {
    case "topology": {
      console.log(JSON.stringify(await axl.topology(), null, 2));
      return;
    }

    case "run": {
      const agent = new HuddleAgent(axl, {
        k: K,
        sellerPeerId: SELLER_PEER_ID,
        sellerApi: SELLER_API,
        knownPeers: KNOWN_PEERS.length > 0 ? KNOWN_PEERS : null,
        autoFund: AUTO_FUND,
        fundDelayMs: FUND_DELAY_MS,
      });
      await agent.init();

      if (args.length >= 4) {
        const intent: Intent = {
          sku: args[0],
          max_unit_price: Number(args[1]),
          deadline_ms: Date.now() + Number(args[2]) * 60 * 60 * 1000,
          qty: Number(args[3]),
        };
        await agent.submit(intent);
      } else if (args.length > 0 && args[0] !== "daemon") {
        process.stderr.write(help);
        process.exit(2);
      }

      // Local API Daemon for UI integration
      const http = await import("http");
      const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        
        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method === "POST" && req.url === "/submit") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
             try {
                const intent = JSON.parse(body);
                await agent.submit(intent);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
             } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: (e as Error).toString() }));
             }
          });
          return;
        }

        if (req.method === "GET" && req.url === "/status") {
           res.writeHead(200, { "Content-Type": "application/json" });
           res.end(JSON.stringify({ 
             axl: AXL,
             logs: getStreamLogs(),
             ...agent.getUIStatus()
           })); 
           return;
        }
        res.writeHead(404);
        res.end();
      });

      // Graceful port-conflict handling: log a warning but keep the P2P loop running.
      // The web UI just won't be able to poll this agent instance.
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.log(`WARNING: PORT ${process.env.PORT || 3001} already in use — UI polling disabled for this agent. Set a unique PORT env var per agent.`);
        } else {
          console.log(`HTTP server error: ${err.message}`);
        }
      });

      const port = process.env.PORT || 3001;
      server.listen(port, () => {
        console.log(`Agent UI backend listening on http://localhost:${port}`);
      });

      console.log(`watching AXL ${AXL} (k=${K})`);
      while (true) {
        const got = await agent.runOnce();
        if (!got) await sleep(300);
      }
    }

    case "seller": {
      const seller = new SellerAgent(axl);
      await seller.init();
      console.log(`seller mode on AXL ${AXL}`);

      const sellerChainCfg = createSellerChainConfigFromEnv();
      const port = Number(process.env.PORT || 3004);
      seller.startHttpServer(port, sellerChainCfg);

      while (true) {
        const got = await seller.runOnce();
        if (!got) await sleep(300);
      }
    }

    default:
      process.stderr.write(help);
      process.exit(2);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
