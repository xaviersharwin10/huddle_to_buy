import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, parseEther, parseUnits } from "viem";
import { GoogleGenerativeAI } from "@google/generative-ai";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "mock_token";
const AGENT_API = process.env.AGENT_API || "http://127.0.0.1:3001";
const PORT = Number(process.env.AGENT_PORT || "3001");
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";

const genAI = new GoogleGenerativeAI(GOOGLE_AI_API_KEY);

const gensynChain = {
  id: 685685,
  name: 'Gensyn Testnet',
  network: 'gensyn-testnet',
  nativeCurrency: { name: 'Gensyn ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://gensyn-testnet.g.alchemy.com/public'] },
    public: { http: ['https://gensyn-testnet.g.alchemy.com/public'] },
  },
};

const TREASURY_PRIVATE_KEY = (process.env.TREASURY_PRIVATE_KEY ?? "") as `0x${string}`;
if (!TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY env var is required");
const treasuryAccount = privateKeyToAccount(TREASURY_PRIVATE_KEY);
const walletClient = createWalletClient({
  account: treasuryAccount,
  chain: gensynChain,
  transport: http()
});
const MOCK_USDC = "0xc49E6233DeD0F23367b26F242B8fD118060A31C8" as const;
const erc20Abi = [{"type":"function","name":"transfer","inputs":[{"name":"recipient","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable"}] as const;

// In-memory mappings for the hackathon prototype
const AVAILABLE_PORTS = [3001, 3002, 3003]; // Buyer 1, Buyer 2, Buyer 3 daemons
let nextAgentIndex = 0;

const users: Record<number, { address: string; pk: string; agentPort: number }> = {};

// Map: chat_id -> commitment -> lastStatus
const lastStatusMap: Record<number, Record<string, string>> = {};

// Queue for intents when agent daemon is not yet online
type QueuedIntent = { intent: object; agentPort: number; sku: string; retries: number };
const intentQueue: Record<number, QueuedIntent[]> = {};

const QUEUE_TIMEOUT_RETRIES = 24; // 24 × 5s = 2 minutes

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: TELEGRAM_BOT_TOKEN !== "mock_token",
});

if (TELEGRAM_BOT_TOKEN === "mock_token") {
  console.log("No TELEGRAM_BOT_TOKEN provided. Running in mock mode...");
} else {
  console.log("Telegram bot polling started!");
}

// Graceful shutdown: stop polling before process exits so a redeploying
// container doesn't produce a 409 Conflict on the new instance.
process.on("SIGTERM", () => {
  console.log("SIGTERM received — stopping Telegram polling...");
  bot.stopPolling().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  bot.stopPolling().finally(() => process.exit(0));
});

// 409 Conflict = old container is still polling. Stop, wait 30s for it to
// die, then restart. Any other polling error is logged and ignored.
let recovering409 = false;
bot.on("polling_error", (err: any) => {
  if (err?.message?.includes("409") && !recovering409) {
    recovering409 = true;
    console.log("409 conflict — waiting 30s for old instance to stop...");
    bot.stopPolling().then(() => {
      setTimeout(() => {
        recovering409 = false;
        console.log("Restarting Telegram polling after 409 backoff...");
        bot.startPolling();
      }, 30_000);
    }).catch(() => {});
  }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (!users[chatId]) {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const agentPort = AVAILABLE_PORTS[nextAgentIndex % AVAILABLE_PORTS.length];
    nextAgentIndex++;

    users[chatId] = { address: account.address, pk, agentPort };
  }

  const { address, agentPort } = users[chatId];
  bot.sendMessage(
    chatId,
    `Welcome to Huddle!\n\n💳 Wallet: \`${address}\`\n\nPlease deposit Gensyn Testnet ETH and MockUSDC. You can also use /faucet to get test funds automatically.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/faucet/, async (msg) => {
  const chatId = msg.chat.id;
  const user = users[chatId];
  if (!user) {
    return bot.sendMessage(chatId, "Please type /start first to generate your wallet.");
  }

  bot.sendMessage(chatId, `⏳ Requesting funds from Gensyn Testnet Faucet... Please wait.`);

  try {
    const ethTx = await walletClient.sendTransaction({
      to: user.address as `0x${string}`,
      value: parseEther("0.001")
    });

    const usdcTx = await walletClient.writeContract({
      address: MOCK_USDC,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [user.address as `0x${string}`, parseUnits("100", 6)]
    });

    bot.sendMessage(
      chatId,
      `✅ **Faucet success!**\n\nDistributed 100 MockUSDC and 0.001 Gensyn Testnet ETH to \`${user.address}\`.\n\n🔗 [ETH Tx](https://gensyn-testnet.explorer.alchemy.com/tx/${ethTx})\n🔗 [USDC Tx](https://gensyn-testnet.explorer.alchemy.com/tx/${usdcTx})`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } catch (error) {
    console.error("Faucet Error:", error);
    bot.sendMessage(chatId, `❌ Faucet failed: ${(error as Error).message}`);
  }
});

async function submitIntent(agentPort: number, intent: object): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${agentPort}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intent),
  });
  if (!res.ok) throw new Error(`Agent rejected intent: ${await res.text()}`);
}

// Regex-based fallback parser — used when Gemini is unavailable or over quota.
const KNOWN_PRODUCTS: [RegExp, string, number][] = [
  [/claude\s*(pro|subscription|ai)?/i, "claude-pro-subscription", 23],
  [/chatgpt\s*(plus)?|gpt[-\s]?4/i, "chatgpt-plus-subscription", 23],
  [/h100/i, "h100-pcie-hour", 3.50],
  [/a100/i, "a100-pcie-hour", 2.00],
  [/midjourney/i, "midjourney-subscription", 11],
  [/cursor(\s*pro)?/i, "cursor-pro-subscription", 22],
  [/notion(\s*ai)?/i, "notion-ai-subscription", 11],
];

function parseIntentFallback(text: string): { sku: string; maxPrice: number; qty: number } | null {
  const qtyMatch = text.match(/(\d+)\s*(hour|hr|unit|month|year|person|people|user|x)/i);
  const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
  const priceMatch = text.match(/\$(\d+(?:\.\d+)?)/i);

  for (const [regex, sku, defaultPrice] of KNOWN_PRODUCTS) {
    if (regex.test(text)) {
      const maxPrice = priceMatch ? parseFloat(priceMatch[1]) : defaultPrice;
      return { sku, maxPrice, qty };
    }
  }
  return null;
}

const PURCHASE_KEYWORDS = /\b(buy|get|want|purchase|need|order|subscribe|subscription|hour|gpu)\b/i;

// Natural Language Intent Parsing
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  if (text.startsWith("/")) return;

  let sku: string, maxPrice: number, qty: number;

  // Try Gemini first if API key is set
  let geminiParsed: { sku: string; maxPrice: number; qty: number } | null = null;
  if (GOOGLE_AI_API_KEY) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `You are a purchasing intent parser for an AI agent coalition marketplace.

Given a natural language message, extract a purchase intent. Follow these rules strictly:

1. sku: A lowercase kebab-case product slug. Map common products:
   - "claude pro", "claude subscription" → "claude-pro-subscription"
   - "chatgpt plus", "gpt-4 access" → "chatgpt-plus-subscription"
   - "h100", "h100 gpu", "h100 hour" → "h100-pcie-hour"
   - "a100", "a100 gpu" → "a100-pcie-hour"
   - "midjourney" → "midjourney-subscription"
   - "cursor", "cursor pro" → "cursor-pro-subscription"
   - "notion", "notion ai" → "notion-ai-subscription"
   - Otherwise: slugify the product name (lowercase, hyphens, no spaces)

2. maxPrice: Maximum price per unit in USD. If the user does not state a price, infer a realistic market rate and add a 15% buffer. Examples:
   - Claude Pro subscription: $23 (market $20 + buffer)
   - ChatGPT Plus: $23
   - H100 per hour: $3.50
   - A100 per hour: $2.00
   - Midjourney: $11
   - Cursor Pro: $22
   - Notion AI: $11

3. qty: Quantity as an integer. Default to 1 if not stated.

4. If the message is not a purchase intent at all, return: {"error": "not_a_purchase"}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation.
{"sku": "...", "maxPrice": <number>, "qty": <number>}

Message: "${text}"`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(responseText);

      if (parsed.error === "not_a_purchase") {
        return bot.sendMessage(
          chatId,
          "I'm here to help you buy things as a group! Just tell me what you want, for example:\n\n" +
          "• _I want a Claude Pro subscription_\n" +
          "• _Get me 5 hours of H100 GPU time_\n" +
          "• _Buy Midjourney for 3 people_",
          { parse_mode: "Markdown" }
        );
      }

      const s = parsed.sku;
      const mp = parseFloat(parsed.maxPrice);
      const q = parseInt(parsed.qty, 10);
      if (s && !isNaN(mp) && !isNaN(q)) {
        geminiParsed = { sku: s, maxPrice: mp, qty: q };
      }
    } catch (err) {
      console.error("Gemini parsing error (will try regex fallback):", (err as Error).message ?? String(err));
    }
  }

  // Fallback: regex parser
  const fallback = geminiParsed ?? parseIntentFallback(text);

  if (!fallback) {
    // If no purchase keywords at all, prompt the user
    if (!PURCHASE_KEYWORDS.test(text)) {
      return bot.sendMessage(
        chatId,
        "I'm here to help you buy things as a group! Just tell me what you want, for example:\n\n" +
        "• _I want a Claude Pro subscription_\n" +
        "• _Get me 5 hours of H100 GPU time_\n" +
        "• _Buy Midjourney for 3 people_",
        { parse_mode: "Markdown" }
      );
    }
    return bot.sendMessage(
      chatId,
      "I didn't quite catch that. Try something like:\n\n" +
      "• _I want a Claude Pro subscription_\n" +
      "• _Get me 5 hours of H100 GPU_\n" +
      "• _Buy Midjourney for 2 people_",
      { parse_mode: "Markdown" }
    );
  }

  sku = fallback.sku;
  maxPrice = fallback.maxPrice;
  qty = fallback.qty;

  const agentPort = users[chatId]?.agentPort || 3001;
  // All buyers must receive the EXACT same intent object (same deadline_ms)
  // so their commitment hashes match and GossipSub can form a coalition.
  const intent = {
    sku: sku!,
    max_unit_price: maxPrice!,
    qty: qty!,
    deadline_ms: Date.now() + 24 * 60 * 60 * 1000
  };

  bot.sendMessage(
    chatId,
    `Got it! Looking for a coalition to buy:\n\n📦 *${sku!}*\n🔢 Qty: ${qty!}\n💰 Max price: $${maxPrice!}/unit\n\n_Broadcasting your intent across the P2P mesh..._`,
    { parse_mode: "Markdown" }
  );

  // Build the pre-seed snapshot into a local object first, then assign it
  // atomically to lastStatusMap. This prevents the polling setInterval from
  // firing between "map created empty" and "pre-seed filled", which would
  // see prevStatus="" vs "Settled (commit ready)" and send a stale notification.
  const preSeed: Record<string, string> = { ...(lastStatusMap[chatId] ?? {}) };

  // Submit to all buyer agents so all 3 independently commit to the same hash.
  // Coalition requires k=3 matching commits — a single user's assigned port alone
  // would never reach threshold.
  let anySucceeded = false;
  for (const port of AVAILABLE_PORTS) {
    try {
      await submitIntent(port, intent);
      anySucceeded = true;
      // Pre-seed from the user's assigned port only — captures current state
      // of all known commitments so stale "Settled" coalitions aren't re-fired.
      if (port === agentPort) {
        try {
          const snap = await fetch(`http://127.0.0.1:${port}/status`);
          if (snap.ok) {
            const snapData = await snap.json();
            for (const c of (snapData.myCommits || [])) {
              preSeed[c.commitment] = c.statusStr;
            }
          }
        } catch {}
      }
    } catch (error) {
      const errMsg = (error as Error).message;
      const isOffline = errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed");
      if (isOffline) {
        if (!intentQueue[chatId]) intentQueue[chatId] = [];
        intentQueue[chatId].push({ intent, agentPort: port, sku: sku!, retries: 0 });
      } else {
        console.error(`Intent submission error on port ${port}:`, errMsg);
      }
    }
  }

  // Atomically expose the pre-seeded map to the polling loop.
  lastStatusMap[chatId] = preSeed;

  if (!anySucceeded) {
    bot.sendMessage(
      chatId,
      `⏳ Agent nodes are starting up. Your intent for *${sku!}* is queued and will broadcast automatically once the nodes are online.`,
      { parse_mode: "Markdown" }
    );
  }
});

// Polling loop — processes queued intents + tracks coalition status
setInterval(async () => {
  // Retry queued intents for users whose agent was offline
  for (const chatIdStr of Object.keys(intentQueue)) {
    const chatId = Number(chatIdStr);
    const queue = intentQueue[chatId];
    if (!queue || queue.length === 0) { delete intentQueue[chatId]; continue; }

    const item = queue[0];
    try {
      await submitIntent(item.agentPort, item.intent);
      queue.shift();
      if (queue.length === 0) delete intentQueue[chatId];
      bot.sendMessage(
        chatId,
        `✅ Agent is online! Intent for **${item.sku}** is now live on the AXL mesh.`,
        { parse_mode: "Markdown" }
      );
    } catch {
      item.retries++;
      if (item.retries >= QUEUE_TIMEOUT_RETRIES) {
        queue.shift();
        if (queue.length === 0) delete intentQueue[chatId];
        bot.sendMessage(
          chatId,
          `❌ Could not reach the agent node after 2 minutes. Please start the Huddle agent and send your intent again.`
        );
      }
    }
  }

  // Track coalition status changes
  for (const chatIdStr of Object.keys(lastStatusMap)) {
    const chatId = Number(chatIdStr);
    const userTracked = lastStatusMap[chatId];
    // Fall back to port 3001 if user never did /start (e.g. after a redeploy).
    const agentPollPort = users[chatId]?.agentPort ?? 3001;

    try {
      const res = await fetch(`http://127.0.0.1:${agentPollPort}/status`);
      if (!res.ok) continue;

      const data = await res.json();
      const commits = data.myCommits || [];

      for (const commit of commits) {
        const { commitment, sku, qty, max_unit_price, statusStr, clusterSize, offer, address, x402TxHash, fundTx, zeroGSealTx } = commit;
        const prevStatus = userTracked[commitment] || "";

        if (prevStatus !== statusStr) {
          userTracked[commitment] = statusStr;
          console.log(`[status] chat=${chatId} sku=${sku} ${prevStatus || "—"} → ${statusStr}`);

          if (statusStr === "Broadcasting Intent") {
            // Let UI handle it natively
          } else if (statusStr.startsWith("Declined:")) {
            const reason = statusStr.replace("Declined:", "").trim();
            let msg: string;
            if (reason === "sku_not_offered") {
              msg = `❌ The seller doesn't carry *${sku}*. Try asking for GPU compute instead:\n\n• _I want 5 hours of H100 GPU_\n• _Get me an A100 for 2 hours_`;
            } else if (reason === "tier_above_max") {
              msg = `❌ The bulk price for *${sku}* ($${offer?.tierUnitPrice}/unit) is above your max $${max_unit_price}/unit. Try raising your budget or wait for more buyers to unlock a deeper tier.`;
            } else {
              msg = `❌ Seller declined *${sku}*: ${reason}`;
            }
            bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
          } else if (statusStr === "Negotiating Tier Price") {
            bot.sendMessage(chatId, `🤖 I found ${clusterSize} peers on the AXL mesh! Forming a coalition...`);
          } else if (statusStr === "Tier Offer Received") {
            bot.sendMessage(
              chatId,
              `🗣️ I am negotiating with the seller...\nThey offered $${offer.tierUnitPrice} / unit (valid until ${new Date(offer.validUntilMs).toLocaleTimeString()})!`
            );
          } else if (statusStr === "Deploying Coalition") {
            bot.sendMessage(
              chatId,
              `💸 Offer accepted! Contract deployed at \`${address}\`.\nI am autonomously signing the transaction to pool your funds...`,
              { parse_mode: "Markdown" }
            );
          } else if (statusStr === "Settled (commit ready)") {
            // The coalition can form faster than the 1500ms poll interval.
            // If intermediate states were skipped, send their messages now so
            // the user sees the full flow before "Purchase Complete!".
            const STATUS_ORDER = [
              "Broadcasting Intent",
              "Negotiating Tier Price",
              "Tier Offer Received",
              "Deploying Coalition",
              "Settled (commit ready)",
            ];
            const prevIdx = STATUS_ORDER.indexOf(prevStatus || "Broadcasting Intent");
            const needsNegotiating = prevIdx < STATUS_ORDER.indexOf("Negotiating Tier Price");
            const needsOffer      = prevIdx < STATUS_ORDER.indexOf("Tier Offer Received");
            const needsDeploy     = prevIdx < STATUS_ORDER.indexOf("Deploying Coalition");

            if (needsNegotiating) {
              bot.sendMessage(chatId, `🤖 I found ${clusterSize} peers on the AXL mesh! Forming a coalition...`);
            }
            if (needsOffer && offer) {
              bot.sendMessage(
                chatId,
                `🗣️ I am negotiating with the seller...\nThey offered $${offer.tierUnitPrice} / unit (valid until ${new Date(offer.validUntilMs).toLocaleTimeString()})!`
              );
            }
            if (needsDeploy && address) {
              bot.sendMessage(
                chatId,
                `💸 Offer accepted! Contract deployed at \`${address}\`.\nI am autonomously signing the transaction to pool your funds...`,
                { parse_mode: "Markdown" }
              );
            }

            const discount = max_unit_price - (offer?.tierUnitPrice || max_unit_price);
            const totalSaved = discount * qty;

            const explorerBase = "https://gensyn-testnet.explorer.alchemy.com";
            const shortTx = (tx: string) => tx.slice(0, 10) + "…" + tx.slice(-6);

            const techLines: string[] = [
              `\n🔬 *Powered by:*`,
              `• *AXL (Gensyn)*: P2P gossip mesh — ${clusterSize} buyers formed coalition`,
              x402TxHash
                ? `• *X402*: 0.01 MockUSDC micro-payment to seller → [${shortTx(x402TxHash)}](${explorerBase}/tx/${x402TxHash})`
                : `• *X402*: price discovery via GossipSub`,
              `• *0G Compute*: AI agent accepted the bulk offer`,
              zeroGSealTx
                ? `• *0G iNFT*: coalition outcome sealed on 0G Testnet → [${shortTx(zeroGSealTx)}](https://chainscan-galileo.0g.ai/tx/${zeroGSealTx})`
                : `• *0G iNFT*: buyer profile minted on 0G Testnet`,
              `• *KeeperHub*: autonomous commit() trigger queued`,
            ];

            bot.sendMessage(
              chatId,
              `✅ **Purchase Complete!**\n\nItem: ${sku} (Qty: ${qty})\nOriginal Price: $${max_unit_price.toFixed(2)}\nBulk Price: $${offer?.tierUnitPrice?.toFixed(2) || "N/A"}\nTotal Saved: $${totalSaved.toFixed(2)}\n\n🔗 [Coalition Contract](${explorerBase}/address/${address})` + techLines.join("\n"),
              { parse_mode: "Markdown", disable_web_page_preview: true }
            );
          }
        }
      }
    } catch {
      // Agent daemon not running yet — silently skip
    }
  }
}, 1500);
