#!/usr/bin/env bash
# scripts/boot-demo.sh
# ──────────────────────────────────────────────────────────────────────────────
# Boot the entire Huddle demo stack on Linux:
#   1. Start all 4 AXL nodes (nodeA/B/C/S)
#   2. Discover pubkeys → build KNOWN_PEERS + SELLER_PEER_ID dynamically
#   3. Start seller agent (nodeS, port 3004)
#   4. Start 3 buyer agents (nodeA/B/C, ports 3001-3003)
#      Each buyer loads its .env.buyer{1,2,3} file and gets KNOWN_PEERS +
#      SELLER_PEER_ID injected at startup.
#   5. Start the Next.js web UI (port 3000) — optional
#
# Usage (from repo root):
#   bash scripts/boot-demo.sh             # start everything
#   bash scripts/boot-demo.sh --no-ui     # skip web UI start
#   bash scripts/boot-demo.sh --kill      # kill all first, then start
#
# Prerequisites:
#   - agent/.env.buyer1, agent/.env.buyer2, agent/.env.buyer3 must exist
#     (copy from agent/.env.buyer*.example and fill in PRIVATE_KEY etc.)
#   - contracts/.env must exist with PRIVATE_KEY and GENSYN_TESTNET_RPC
#
# After running:
#   - Web UI: http://localhost:3000
#   - Buyer 1 agent:  http://localhost:3001/status
#   - Buyer 2 agent:  http://localhost:3002/status
#   - Buyer 3 agent:  http://localhost:3003/status
#   - Seller agent:   http://localhost:3004/status
#   - Logs: logs/agent-buyer1.log, logs/agent-buyer2.log, etc.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
LOGS="$ROOT/logs"

mkdir -p "$LOGS"

START_UI=true
DO_KILL=false

for arg in "$@"; do
  case "$arg" in
    --no-ui)   START_UI=false ;;
    --kill)    DO_KILL=true   ;;
  esac
done

# ── 0. Optional kill ──────────────────────────────────────────────────────────
if $DO_KILL; then
  echo "[boot] Killing existing AXL nodes and agents..."
  pkill -f "axl/bin/node"    2>/dev/null || true
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  sleep 1
fi

# ── 1. Check buyer env files ──────────────────────────────────────────────────
MISSING_ENVS=()
for N in 1 2 3; do
  if [ ! -f "$AGENT_DIR/.env.buyer$N" ]; then
    MISSING_ENVS+=("agent/.env.buyer$N")
  fi
done

if [ ${#MISSING_ENVS[@]} -gt 0 ]; then
  echo "ERROR: Missing buyer env files:"
  for f in "${MISSING_ENVS[@]}"; do
    echo "  $f  (copy from ${f}.example and fill in PRIVATE_KEY etc.)"
  done
  echo ""
  echo "Example:"
  echo "  cp agent/.env.buyer1.example agent/.env.buyer1"
  echo "  # Edit agent/.env.buyer1 — set PRIVATE_KEY, FACTORY_ADDRESS, etc."
  exit 1
fi

# ── 2. Start AXL nodes ────────────────────────────────────────────────────────
echo "[boot] Starting AXL nodes..."
bash "$ROOT/scripts/start-nodes.sh"
echo ""

# ── 3. Discover pubkeys ───────────────────────────────────────────────────────
echo "[boot] Reading pubkeys from running nodes..."

get_pubkey() {
  curl -sf "http://127.0.0.1:$1/topology" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])"
}

PUBKEY_A=$(get_pubkey 9002)
PUBKEY_B=$(get_pubkey 9012)
PUBKEY_C=$(get_pubkey 9022)
PUBKEY_S=$(get_pubkey 9032)

KNOWN_PEERS="$PUBKEY_A,$PUBKEY_B,$PUBKEY_C,$PUBKEY_S"
SELLER_PEER_ID="$PUBKEY_S"

echo "  nodeA: ${PUBKEY_A:0:16}..."
echo "  nodeB: ${PUBKEY_B:0:16}..."
echo "  nodeC: ${PUBKEY_C:0:16}..."
echo "  nodeS: ${PUBKEY_S:0:16}..."
echo "  SELLER_PEER_ID=${PUBKEY_S:0:16}..."
echo ""

# ── 4. Start seller agent ─────────────────────────────────────────────────────
echo "[boot] Starting seller agent (AXL=9032, PORT=3004)..."
SELLER_LOG="$LOGS/agent-seller.log"
echo "--- Seller starting at $(date -Iseconds) ---" >> "$SELLER_LOG"

(
  cd "$AGENT_DIR"
  AXL_API="http://127.0.0.1:9032" PORT="3004" \
    exec pnpm exec tsx src/index.ts seller
) >> "$SELLER_LOG" 2>&1 &
disown

sleep 1
echo "  Seller agent started → $SELLER_LOG"
echo ""

# ── 5. Start 3 buyer agents ───────────────────────────────────────────────────
declare -A BUYER_PORTS=([1]=3001 [2]=3002 [3]=3003)
declare -A BUYER_AXL=([1]="http://127.0.0.1:9002" [2]="http://127.0.0.1:9012" [3]="http://127.0.0.1:9022")

for N in 1 2 3; do
  PORT="${BUYER_PORTS[$N]}"
  AXL="${BUYER_AXL[$N]}"
  ENV_FILE="$AGENT_DIR/.env.buyer$N"
  BUYER_LOG="$LOGS/agent-buyer$N.log"

  echo "[boot] Starting buyer$N (AXL=$AXL, PORT=$PORT)..."
  echo "--- Buyer$N starting at $(date -Iseconds) ---" >> "$BUYER_LOG"

  # Load buyer env into a clean environment, then add dynamic vars
  (
    cd "$AGENT_DIR"
    set -o allexport
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +o allexport

    # Override/inject dynamic values — always authoritative
    export AXL_API="$AXL"
    export PORT="$PORT"
    export KNOWN_PEERS="$KNOWN_PEERS"
    export SELLER_PEER_ID="$SELLER_PEER_ID"

    exec pnpm exec tsx src/index.ts run daemon
  ) >> "$BUYER_LOG" 2>&1 &
  disown

  sleep 0.5
  echo "  Buyer$N started → $BUYER_LOG"
done

echo ""

# ── 6. Optionally start Web UI ────────────────────────────────────────────────
if $START_UI; then
  WEB_LOG="$LOGS/web.log"
  echo "[boot] Starting Next.js web UI (PORT=3000)..."
  echo "--- Web UI starting at $(date -Iseconds) ---" >> "$WEB_LOG"
  (
    cd "$ROOT/web"
    exec pnpm dev
  ) >> "$WEB_LOG" 2>&1 &
  disown
  sleep 2
  echo "  Web UI started → $WEB_LOG"
  echo "  Open: http://localhost:3000"
fi

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║  Huddle demo stack is running!                ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Web UI      → http://localhost:3000           ║"
echo "║  Buyer 1     → http://localhost:3001/status    ║"
echo "║  Buyer 2     → http://localhost:3002/status    ║"
echo "║  Buyer 3     → http://localhost:3003/status    ║"
echo "║  Seller      → http://localhost:3004/status    ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Logs in: logs/                                ║"
echo "║  Stop all: pkill -f 'axl/bin/node|tsx src'     ║"
echo "╚════════════════════════════════════════════════╝"
echo ""
echo "KNOWN_PEERS=$KNOWN_PEERS"
echo "SELLER_PEER_ID=$SELLER_PEER_ID"
