#!/usr/bin/env bash
# scripts/start-railway.sh
# ──────────────────────────────────────────────────────────────────────────────
# Railway production startup — runs every service inside a single container.
#
# Services started (all on localhost):
#   AXL mesh  : nodeA :9002, nodeB :9012, nodeC :9022, nodeS :9032
#   Seller    : port 3004  (X402 quote server + GossipSub)
#   Buyer 1-3 : ports 3001-3003  (buyer/coordinator agents)
#   Telegram  : polling mode (no inbound port)
#   Health    : $PORT  (Railway health-check endpoint)
#
# Required Railway env vars:
#   TELEGRAM_BOT_TOKEN, GOOGLE_AI_API_KEY, TREASURY_PRIVATE_KEY
#   BUYER1_PRIVATE_KEY, BUYER2_PRIVATE_KEY, BUYER3_PRIVATE_KEY
#   RPC_URL, FACTORY_ADDRESS, PAY_TOKEN_ADDRESS, KEEPER_ADDRESS, SELLER_ADDRESS
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/app"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# ── 1. AXL mesh nodes ─────────────────────────────────────────────────────────
echo "=== [1/6] Starting AXL mesh nodes ==="
bash "$ROOT/scripts/start-nodes.sh"

# ── 2. Discover pubkeys ───────────────────────────────────────────────────────
echo ""
echo "=== [2/6] Discovering AXL pubkeys ==="
get_pubkey() {
  curl -sf "http://127.0.0.1:$1/topology" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])"
}

PUBKEY_A=$(get_pubkey 9002)
PUBKEY_B=$(get_pubkey 9012)
PUBKEY_C=$(get_pubkey 9022)
PUBKEY_S=$(get_pubkey 9032)
KNOWN_PEERS="$PUBKEY_A,$PUBKEY_B,$PUBKEY_C,$PUBKEY_S"

echo "  SELLER_PEER_ID = ${PUBKEY_S:0:16}..."
echo "  KNOWN_PEERS    = ${KNOWN_PEERS:0:36}..."

# ── 3. Seller agent ───────────────────────────────────────────────────────────
echo ""
echo "=== [3/6] Starting seller agent (port 3004) ==="
(
  cd "$ROOT/agent"
  exec env \
    AXL_API="http://127.0.0.1:9032" \
    PORT="3004" \
    RPC_URL="${RPC_URL:-}" \
    PAY_TOKEN_ADDRESS="${PAY_TOKEN_ADDRESS:-}" \
    SELLER_ADDRESS="${SELLER_ADDRESS:-}" \
    pnpm exec tsx src/index.ts seller
) >> "$LOGS/seller.log" 2>&1 &

sleep 2
echo "  seller started → $LOGS/seller.log"

# ── 4. Buyer agents ───────────────────────────────────────────────────────────
echo ""
echo "=== [4/6] Starting 3 buyer agents (ports 3001-3003) ==="

declare -A AXL_PORTS=([1]=9002 [2]=9012 [3]=9022)
declare -A AGENT_PORTS=([1]=3001 [2]=3002 [3]=3003)

for N in 1 2 3; do
  PK_VAR="BUYER${N}_PRIVATE_KEY"
  BUYER_PK="${!PK_VAR:-}"

  (
    cd "$ROOT/agent"
    exec env \
      AXL_API="http://127.0.0.1:${AXL_PORTS[$N]}" \
      PORT="${AGENT_PORTS[$N]}" \
      PRIVATE_KEY="$BUYER_PK" \
      KNOWN_PEERS="$KNOWN_PEERS" \
      SELLER_PEER_ID="$PUBKEY_S" \
      SELLER_API="http://127.0.0.1:3004" \
      FACTORY_ADDRESS="${FACTORY_ADDRESS:-}" \
      PAY_TOKEN_ADDRESS="${PAY_TOKEN_ADDRESS:-}" \
      KEEPER_ADDRESS="${KEEPER_ADDRESS:-}" \
      SELLER_ADDRESS="${SELLER_ADDRESS:-}" \
      RPC_URL="${RPC_URL:-}" \
      CHAIN_ID="${CHAIN_ID:-685685}" \
      PAY_TOKEN_DECIMALS="${PAY_TOKEN_DECIMALS:-6}" \
      AUTO_FUND="true" \
      K="3" \
      pnpm exec tsx src/index.ts run daemon
  ) >> "$LOGS/buyer${N}.log" 2>&1 &

  sleep 0.5
  echo "  buyer${N} started on port ${AGENT_PORTS[$N]} → $LOGS/buyer${N}.log"
done

# ── 5. Telegram bot ───────────────────────────────────────────────────────────
echo ""
echo "=== [5/6] Starting Telegram bot ==="
(
  cd "$ROOT/bot"
  exec pnpm exec tsx src/index.ts
) >> "$LOGS/bot.log" 2>&1 &

echo "  bot started → $LOGS/bot.log"

# ── 6. Health-check server (foreground — keeps container alive) ───────────────
echo ""
echo "=== [6/6] Health server on port ${PORT:-8080} ==="
exec node -e "
const http = require('http');
const fs   = require('fs');
const port = process.env.PORT || 8080;
const LOGS = '/app/logs';

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'huddle-to-buy' }));
    return;
  }

  if (url.pathname === '/logs') {
    const name = (url.searchParams.get('f') || 'seller').replace(/[^a-z0-9]/g, '');
    try {
      const raw   = fs.readFileSync(LOGS + '/' + name + '.log', 'utf8');
      const lines = raw.split('\n').slice(-80).join('\n');
      res.writeHead(200);
      res.end(JSON.stringify({ log: lines }));
    } catch {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'log not found' }));
    }
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'ok',
    endpoints: ['/health', '/logs?f=seller', '/logs?f=buyer1', '/logs?f=buyer2', '/logs?f=buyer3', '/logs?f=bot']
  }));
}).listen(port, '0.0.0.0', () => {
  console.log('Huddle-to-buy health server listening on port ' + port);
});
"
