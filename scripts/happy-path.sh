#!/usr/bin/env bash
# scripts/happy-path.sh
# ──────────────────────────────────────────────────────────────────────────────
# P0 Happy-Path Demo — Full end-to-end coalition flow on Linux.
#
# Flow:
#   1. Kill stale procs + start 4 AXL nodes fresh
#   2. Start seller agent + 3 buyers (all AUTO_FUND=true)
#   3. Watch logs until "COALITION DEPLOYED" appears → extract address
#   4. Run keeper.ts → commit() → CoalitionCommitted event
#
# Prerequisites:
#   - agent/.env.buyer{1,2,3} filled in (PRIVATE_KEY, FACTORY_ADDRESS, etc.)
#   - contracts/.env filled in (PRIVATE_KEY / KEEPER_PRIVATE_KEY)
#     OR pass KEEPER_PRIVATE_KEY as env var:
#       KEEPER_PRIVATE_KEY=0x... bash scripts/happy-path.sh
#
# Usage:
#   bash scripts/happy-path.sh
#   SKU=h100-pcie-hour MAX_PRICE=1.5 QTY=10 DEADLINE_HRS=1 bash scripts/happy-path.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
CONTRACT_DIR="$ROOT/contracts"
LOGS="$ROOT/logs"

mkdir -p "$LOGS"

# Configurable via env
SKU="${SKU:-h100-pcie-hour}"
MAX_PRICE="${MAX_PRICE:-1.5}"
QTY="${QTY:-10}"
DEADLINE_HRS="${DEADLINE_HRS:-1}"
WATCH_TIMEOUT="${WATCH_TIMEOUT:-180}"   # seconds to wait for coalition deploy

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Huddle Day 5 — P0 Happy Path Demo (Linux)              ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  SKU=$SKU  max=\$$MAX_PRICE  deadline=${DEADLINE_HRS}h  qty=$QTY"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Kill stale processes ───────────────────────────────────────────────────
echo "[1/5] Killing stale AXL nodes and agents..."
pkill -f "axl/bin/node"     2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
sleep 1

# ── 2. Start AXL nodes ────────────────────────────────────────────────────────
echo "[2/5] Starting AXL nodes..."
bash "$ROOT/scripts/start-nodes.sh"
echo ""

# ── 3. Discover pubkeys ───────────────────────────────────────────────────────
get_pubkey() {
  curl -sf "http://127.0.0.1:$1/topology" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])"
}

PUBKEY_A=$(get_pubkey 9002)
PUBKEY_B=$(get_pubkey 9012)
PUBKEY_C=$(get_pubkey 9022)
PUBKEY_S=$(get_pubkey 9032)
KNOWN_PEERS="$PUBKEY_A,$PUBKEY_B,$PUBKEY_C,$PUBKEY_S"
SELLER_PEER_ID="$PUBKEY_S"
echo "[3/5] Pubkeys discovered. SELLER=${PUBKEY_S:0:16}..."
echo ""

# ── 4. Start seller + 3 buyers ────────────────────────────────────────────────
echo "[4/5] Starting seller + 3 buyers..."

# Seller
SELLER_LOG="$LOGS/agent-seller.log"
printf "\n--- Happy-path seller starting at %s ---\n" "$(date -Iseconds)" >> "$SELLER_LOG"
(
  cd "$AGENT_DIR"
  AXL_API="http://127.0.0.1:9032" PORT="3004" exec pnpm exec tsx src/index.ts seller
) >> "$SELLER_LOG" 2>&1 &
disown
sleep 1
echo "  seller started → $SELLER_LOG"

# Buyers
declare -A BUYER_AXL=([1]="http://127.0.0.1:9002" [2]="http://127.0.0.1:9012" [3]="http://127.0.0.1:9022")
declare -A BUYER_PORT=([1]=3001 [2]=3002 [3]=3003)

for N in 1 2 3; do
  ENV_FILE="$AGENT_DIR/.env.buyer$N"
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy from ${ENV_FILE}.example and fill in values."
    exit 1
  fi

  BLOG="$LOGS/agent-buyer$N.log"
  printf "\n--- Happy-path buyer%s starting at %s ---\n" "$N" "$(date -Iseconds)" >> "$BLOG"

  (
    cd "$AGENT_DIR"
    set -o allexport
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +o allexport
    export AXL_API="${BUYER_AXL[$N]}"
    export PORT="${BUYER_PORT[$N]}"
    export KNOWN_PEERS="$KNOWN_PEERS"
    export SELLER_PEER_ID="$SELLER_PEER_ID"
    export AUTO_FUND="true"
    exec pnpm exec tsx src/index.ts run "$SKU" "$MAX_PRICE" "$DEADLINE_HRS" "$QTY"
  ) >> "$BLOG" 2>&1 &
  disown

  sleep 0.5
  echo "  buyer$N started → $BLOG"
done

echo ""

# ── 5. Watch for coalition address ────────────────────────────────────────────
echo "[5/5] Watching for COALITION DEPLOYED in logs (up to ${WATCH_TIMEOUT}s)..."
echo "      Tail logs in another terminal: tail -f $LOGS/agent-buyer1.log"
echo ""

COALITION_ADDRESS=""
DEADLINE=$(($(date +%s) + WATCH_TIMEOUT))
BUYER1_LOG="$LOGS/agent-buyer1.log"
BUYER2_LOG="$LOGS/agent-buyer2.log"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 2

  # Search all buyer logs for the coalition address
  for LOG in "$BUYER1_LOG" "$BUYER2_LOG" "$LOGS/agent-buyer3.log"; do
    if [ -f "$LOG" ]; then
      MATCH=$(grep -oP 'COALITION DEPLOYED[^:]*: \K0x[0-9a-fA-F]{40}' "$LOG" 2>/dev/null | tail -1 || true)
      if [ -n "$MATCH" ]; then
        COALITION_ADDRESS="$MATCH"
        break 2
      fi
    fi
  done

  printf "  ... waiting ..."$'\r'
done

echo ""

if [ -z "$COALITION_ADDRESS" ]; then
  echo "ERROR: Timed out waiting for coalition address after ${WATCH_TIMEOUT}s."
  echo ""
  echo "Possible causes:"
  echo "  - Buyers haven't reached k=3 threshold yet (check KNOWN_PEERS is set)"
  echo "  - Seller didn't respond (check logs/agent-seller.log)"
  echo "  - Onchain disabled (FACTORY_ADDRESS not set in .env.buyer* files)"
  echo ""
  echo "Last 20 lines of buyer1 log:"
  tail -20 "$BUYER1_LOG" 2>/dev/null || echo "(log empty)"
  exit 1
fi

echo "✅ Coalition deployed: $COALITION_ADDRESS"
echo ""

# ── Run keeper → commit() ─────────────────────────────────────────────────────
echo "Running keeper → commit()..."
echo "  Contract: $COALITION_ADDRESS"

# Load contracts/.env for PRIVATE_KEY / KEEPER_PRIVATE_KEY if not already set
# Save coalition address first — source may overwrite it with a stale value from .env
_NEW_COALITION="$COALITION_ADDRESS"
if [ -f "$CONTRACT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1090,SC1091
  source "$CONTRACT_DIR/.env"
  set +o allexport
fi
COALITION_ADDRESS="$_NEW_COALITION"

(
  cd "$CONTRACT_DIR"
  COALITION_ADDRESS="$COALITION_ADDRESS" \
  STOP_ON_TERMINAL="true" \
  POLL_MS="4000" \
  pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet
)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  HAPPY PATH COMPLETE — commit() called successfully  ║"
echo "║  Coalition: $COALITION_ADDRESS  ║"
echo "║  View on Gensyn Explorer:                                       ║"
echo "║  https://gensyn-testnet.explorer.alchemy.com/address/$COALITION_ADDRESS ║"
echo "╚══════════════════════════════════════════════════════════╝"
