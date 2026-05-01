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
    `Welcome to Huddle!\n\n💳 Wallet: \`${address}\`\n🔌 Node: \`localhost:${agentPort}\`\n\nPlease deposit Gensyn Testnet ETH and MockUSDC. You can also use /faucet to get test funds automatically.`,
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

// Natural Language Intent Parsing
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  if (text.startsWith("/")) return;

  if (!GOOGLE_AI_API_KEY) {
    return bot.sendMessage(chatId, "Google AI API key is missing. Please set GOOGLE_AI_API_KEY in the .env file.");
  }

  let sku: string, maxPrice: number, qty: number;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const prompt = `You are an intent parser. Extract the SKU (product name), max price, and quantity from the following user message. Return ONLY a valid JSON object with the keys "sku", "maxPrice", and "qty", and absolutely no markdown formatting, text, or backticks around it. If values are missing or invalid, do your best to infer or return a clear error in JSON.
    Message: "${text}"`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "");
    const parsed = JSON.parse(responseText);

    sku = parsed.sku;
    maxPrice = parseFloat(parsed.maxPrice);
    qty = parseInt(parsed.qty, 10);

    if (!sku || isNaN(maxPrice) || isNaN(qty)) {
      throw new Error("Missing or invalid fields in extracted JSON");
    }
  } catch (err) {
    console.error("Gemini Parsing Error, falling back to Regex:", err);
    const regex = /buy\s+([a-zA-Z0-9-]+).*?\$([0-9.]+).*?qty\s+([0-9]+)/i;
    const match = text.match(regex);
    if (match) {
      sku = match[1];
      maxPrice = parseFloat(match[2]);
      qty = parseInt(match[3], 10);
    } else {
      return bot.sendMessage(
        chatId,
        "I didn't understand that. Please send an intent like: `I want to buy h100-pcie-hour, max price $1.50, qty 100`",
        { parse_mode: "Markdown" }
      );
    }
  }

  const agentPort = users[chatId]?.agentPort || 3001;
  const intent = {
    sku: sku!,
    max_unit_price: maxPrice!,
    qty: qty!,
    deadline_ms: Date.now() + 24 * 60 * 60 * 1000
  };

  bot.sendMessage(
    chatId,
    `Understood! Submitting Intent:\n📦 SKU: ${sku!}\n💰 Max Price: $${maxPrice!}\n🔢 Qty: ${qty!}\n\nBroadcasting from Agent Node (Port ${agentPort}) to the AXL mesh...`
  );

  try {
    await submitIntent(agentPort, intent);
    if (!lastStatusMap[chatId]) lastStatusMap[chatId] = {};
  } catch (error) {
    const errMsg = (error as Error).message;
    const isOffline = errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed");

    if (isOffline) {
      if (!intentQueue[chatId]) intentQueue[chatId] = [];
      intentQueue[chatId].push({ intent, agentPort, sku: sku!, retries: 0 });
      if (!lastStatusMap[chatId]) lastStatusMap[chatId] = {};
      bot.sendMessage(
        chatId,
        `⏳ Agent node is not running yet. Your intent for **${sku!}** is queued and will broadcast automatically once the node comes online.`,
        { parse_mode: "Markdown" }
      );
    } else {
      console.error("Intent submission error:", error);
      bot.sendMessage(chatId, `❌ Error submitting intent: ${errMsg}`);
    }
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
    const user = users[chatId];

    if (!user) continue;

    try {
      const res = await fetch(`http://127.0.0.1:${user.agentPort}/status`);
      if (!res.ok) continue;

      const data = await res.json();
      const commits = data.myCommits || [];

      for (const commit of commits) {
        const { commitment, sku, qty, max_unit_price, statusStr, clusterSize, offer, address } = commit;
        const prevStatus = userTracked[commitment] || "";

        if (prevStatus !== statusStr) {
          userTracked[commitment] = statusStr;

          if (statusStr === "Broadcasting Intent") {
            // Let UI handle it natively
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
            const discount = max_unit_price - (offer?.tierUnitPrice || max_unit_price);
            const totalSaved = discount * qty;

            bot.sendMessage(
              chatId,
              `✅ **Purchase Complete!**\n\nItem: ${sku} (Qty: ${qty})\nOriginal Price Target: $${max_unit_price.toFixed(2)}\nBulk Discount Achieved: $${offer?.tierUnitPrice?.toFixed(2) || "N/A"}\nTotal Saved: $${totalSaved.toFixed(2)}\n\n🔗 Gensyn Testnet Tx: [View on Explorer](https://gensyn-testnet.explorer.alchemy.com/address/${address})`,
              { parse_mode: "Markdown", disable_web_page_preview: true }
            );
          }
        }
      }
    } catch {
      // Agent daemon not running yet — silently skip
    }
  }
}, 5000);
