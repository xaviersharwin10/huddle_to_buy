#!/usr/bin/env bash
# scripts/dropout-replay.sh
# ──────────────────────────────────────────────────────────────────────────────
# P1 Drop-out Replay Demo — Buyer 3 never calls fund(). Coalition expires.
# Keeper fires refundAll() automatically.
#
# Flow:
#   1. Kill stale procs + start 4 AXL nodes fresh
#   2. Start seller + buyer1 + buyer2 (AUTO_FUND=true)
#   3. Start buyer3 with AUTO_FUND=false (simulates dropout)
#   4. Watch for COALITION DEPLOYED → extract address
#   5. Keeper polls → detects validUntil expiry → calls refundAll()
#
# Note: Use a SHORT deadline so you don't wait hours.
#   Default DEADLINE_HRS=0.003 ≈ ~10 minutes.
#
# Usage:
#   bash scripts/dropout-replay.sh
#   DEADLINE_HRS=0.002 bash scripts/dropout-replay.sh   # ~7 min deadline
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
CONTRACT_DIR="$ROOT/contracts"
LOGS="$ROOT/logs"

mkdir -p "$LOGS"

SKU="${SKU:-h100-pcie-hour}"
MAX_PRICE="${MAX_PRICE:-1.5}"
QTY="${QTY:-10}"
DEADLINE_HRS="${DEADLINE_HRS:-0.003}"  # ~10 minutes — short for demo
WATCH_TIMEOUT="${WATCH_TIMEOUT:-180}"

DEADLINE_MINS=$(python3 -c "print(round(float('$DEADLINE_HRS') * 60, 1))")

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  Huddle Day 5 — P1 Drop-out Replay Demo (Linux)              ║"
echo "╠════════════════════════════════════════════════════════════════╣"
echo "║  Buyer3 will NOT fund (AUTO_FUND=false). Coalition expires.   ║"
echo "║  Keeper fires refundAll() after ~${DEADLINE_MINS} min.                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Kill stale processes ───────────────────────────────────────────────────
echo "[1/5] Killing stale processes..."
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
echo "[3/5] Pubkeys discovered."
echo ""

# ── 4. Start seller + buyers (buyer3 = dropout) ───────────────────────────────
echo "[4/5] Starting seller + buyers (buyer3 has AUTO_FUND=false)..."

# Seller
SELLER_LOG="$LOGS/agent-seller.log"
printf "\n--- Dropout seller starting at %s ---\n" "$(date -Iseconds)" >> "$SELLER_LOG"
(
  cd "$AGENT_DIR"
  AXL_API="http://127.0.0.1:9032" PORT="3004" exec pnpm exec tsx src/index.ts seller
) >> "$SELLER_LOG" 2>&1 &
disown
sleep 1
echo "  seller started → $SELLER_LOG"

declare -A BUYER_AXL=([1]="http://127.0.0.1:9002" [2]="http://127.0.0.1:9012" [3]="http://127.0.0.1:9022")
declare -A BUYER_PORT=([1]=3001 [2]=3002 [3]=3003)

for N in 1 2 3; do
  ENV_FILE="$AGENT_DIR/.env.buyer$N"
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found."
    exit 1
  fi

  BLOG="$LOGS/agent-buyer$N.log"
  printf "\n--- Dropout buyer%s starting at %s ---\n" "$N" "$(date -Iseconds)" >> "$BLOG"

  # Buyer 3 is the dropout — always override AUTO_FUND=false
  AUTO_FUND_VAL="true"
  if [ "$N" -eq 3 ]; then
    AUTO_FUND_VAL="false"
    echo "  buyer3 (DROP-OUT — AUTO_FUND=false) → $BLOG"
  else
    echo "  buyer$N (will fund) → $BLOG"
  fi

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
    export AUTO_FUND="$AUTO_FUND_VAL"
    exec pnpm exec tsx src/index.ts run "$SKU" "$MAX_PRICE" "$DEADLINE_HRS" "$QTY"
  ) >> "$BLOG" 2>&1 &
  disown

  sleep 0.5
done

echo ""

# ── 5. Watch for coalition address ────────────────────────────────────────────
echo "[5/5] Watching for COALITION DEPLOYED (up to ${WATCH_TIMEOUT}s)..."
echo "      Buyer3 will show: '(AUTO_FUND=false — skipping fund)'"
echo "      Buyer1/2 will fund. Coalition stays at 2/${QTY} funded."
echo ""

COALITION_ADDRESS=""
END_TIME=$(($(date +%s) + WATCH_TIMEOUT))

while [ "$(date +%s)" -lt "$END_TIME" ]; do
  sleep 2
  for LOG in "$LOGS/agent-buyer1.log" "$LOGS/agent-buyer2.log" "$LOGS/agent-buyer3.log"; do
    if [ -f "$LOG" ]; then
      MATCH=$(grep -oP 'COALITION DEPLOYED[^:]*: \K0x[0-9a-fA-F]{40}' "$LOG" 2>/dev/null | tail -1 || true)
      if [ -n "$MATCH" ]; then
        COALITION_ADDRESS="$MATCH"
        break 2
      fi
    fi
  done
  printf "  ... waiting for coalition deploy ..."$'\r'
done

echo ""

if [ -z "$COALITION_ADDRESS" ]; then
  echo "ERROR: Timed out waiting for coalition address."
  echo "Last 20 lines of buyer1 log:"
  tail -20 "$LOGS/agent-buyer1.log" 2>/dev/null || echo "(empty)"
  exit 1
fi

echo "✅ Coalition deployed: $COALITION_ADDRESS"
echo "   Buyer3 skipped fund(). Coalition is UNDERFUNDED."
echo ""

# Load contracts env
if [ -f "$CONTRACT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1090,SC1091
  source "$CONTRACT_DIR/.env"
  set +o allexport
fi

echo "Running keeper — polling until validUntil expires, then refundAll()..."
echo "  Contract: $COALITION_ADDRESS"
echo "  validUntil ≈ now + ~${DEADLINE_MINS} min (set by buyer's deadline)"
echo "  Keeper polls every 4s. This will take until the deadline elapses."
echo "  (Tip: watch progress with: tail -f contracts/logs/keeper.log)"
echo ""

(
  cd "$CONTRACT_DIR"
  COALITION_ADDRESS="$COALITION_ADDRESS" \
  STOP_ON_TERMINAL="true" \
  POLL_MS="4000" \
  pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet
)

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  ✅  DROP-OUT REPLAY COMPLETE — refundAll() fired             ║"
echo "║  Buyers 1 & 2 received USDC refunds automatically.           ║"
echo "║  Coalition: $COALITION_ADDRESS    ║"
echo "║  View on Gensyn Explorer:                                     ║"
echo "║  https://gensyn-testnet.explorer.alchemy.com/address/$COALITION_ADDRESS ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
