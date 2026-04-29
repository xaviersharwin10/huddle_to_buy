import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GoogleGenerativeAI } from "@google/generative-ai";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "mock_token";
const AGENT_API = process.env.AGENT_API || "http://127.0.0.1:3001";
const PORT = Number(process.env.AGENT_PORT || "3001");
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";

const genAI = new GoogleGenerativeAI(GOOGLE_AI_API_KEY);


// In-memory mappings for the hackathon prototype
const users: Record<number, { address: string; pk: string }> = {};

// Keep track of the last status to only notify when things change
// Map: chat_id -> commitment -> lastStatus
const lastStatusMap: Record<number, Record<string, string>> = {};

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  // If no token is provided, just run dry (won't actually connect to telegram)
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
    users[chatId] = {
      address: account.address,
      pk,
    };
  }

  const { address } = users[chatId];
  bot.sendMessage(
    chatId,
    `Welcome to Huddle! Here is your Agent Wallet: \`${address}\`\n\nPlease deposit Gensyn Testnet ETH and MockUSDC. You can also use /faucet to get test funds automatically.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/faucet/, async (msg) => {
  const chatId = msg.chat.id;
  const user = users[chatId];
  if (!user) {
    return bot.sendMessage(chatId, "Please type /start first to generate your wallet.");
  }
  // Mock faucet implementation
  bot.sendMessage(
    chatId,
    `✅ Faucet success! Distributed 10,000 MockUSDC and 0.5 Gensyn Testnet ETH to \`${user.address}\`.`,
    { parse_mode: "Markdown" }
  );
});

// Natural Language Intent Parsing
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  if (text.startsWith("/")) return;

  if (!GOOGLE_AI_API_KEY) {
    return bot.sendMessage(chatId, "Google AI API key is missing. Please set GOOGLE_AI_API_KEY in the .env file.");
  }

  let sku, maxPrice, qty;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
    console.error("Gemini Parsing Error:", err);
    return bot.sendMessage(
      chatId,
      "I didn't understand that. Please send an intent like: `I want to buy h100-pcie-hour, max price $1.50, qty 100`",
      { parse_mode: "Markdown" }
    );
  }

  const intent = {
    sku: sku,
    max_unit_price: maxPrice,
    qty: qty,
    deadline_ms: 24 * 60 * 60 * 1000 // 24 hours relative from now
  };

  bot.sendMessage(
    chatId,
    `Understood! Submitting Intent:\n📦 SKU: ${sku}\n💰 Max Price: $${maxPrice}\n🔢 Qty: ${qty}\n\nBroadcasting to the AXL mesh...`
  );

  try {
    const res = await fetch(`${AGENT_API}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent),
    });

    if (!res.ok) {
      throw new Error(`Failed to submit intent: ${await res.text()}`);
    }

    if (!lastStatusMap[chatId]) {
      lastStatusMap[chatId] = {};
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, `❌ Error submitting intent: ${(error as Error).message}`);
  }
});

// Polling loop for local Agent daemon
setInterval(async () => {
  try {
    const res = await fetch(`${AGENT_API}/status`);
    if (!res.ok) return;

    const data = await res.json();
    const commits = data.myCommits || [];

    // For hackathon simplicity, we assume there's only 1 Telegram user running 
    // against this local agent instance at a time (e.g. Chat ID logic maps 1:1, but here we just loop known users).
    // Or we could just notify all users that have submitted an intent. Let's iterate users actively tracking.
    for (const chatIdStr of Object.keys(lastStatusMap)) {
      const chatId = Number(chatIdStr);
      const userTracked = lastStatusMap[chatId];

      for (const commit of commits) {
        const {
          commitment,
          sku,
          qty,
          max_unit_price,
          statusStr,
          clusterSize,
          offer,
          address
        } = commit;
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
             const originalTotal = qty * max_unit_price;

             bot.sendMessage(
                 chatId,
                 `✅ **Purchase Complete!**\n\nItem: ${sku} (Qty: ${qty})\nOriginal Price Target: $${max_unit_price.toFixed(2)}\nBulk Discount Achieved: $${offer?.tierUnitPrice?.toFixed(2) || "N/A"}\nTotal Saved: $${totalSaved.toFixed(2)}\n\n🔗 Gensyn Testnet Tx: [View on Explorer](https://explorer.gensyn-testnet.g.alchemy.com/address/${address})`,
                 { parse_mode: "Markdown", disable_web_page_preview: true }
             );
          }
        }
      }
    }
  } catch (e) {
    // Ignore fetch errors (agent might be down)
  }
}, 5000);