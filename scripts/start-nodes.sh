#!/usr/bin/env bash
# scripts/start-nodes.sh
# ──────────────────────────────────────────────────────────────────────────────
# Start all 4 AXL nodes (nodeA, nodeB, nodeC, nodeS) as background processes.
# Logs go to logs/axl-<node>.log.
#
# Usage (from repo root):
#   bash scripts/start-nodes.sh          # start fresh
#   bash scripts/start-nodes.sh --kill   # kill existing first, then restart
#
# After running, node APIs are at:
#   nodeA → http://127.0.0.1:9002
#   nodeB → http://127.0.0.1:9012
#   nodeC → http://127.0.0.1:9022
#   nodeS → http://127.0.0.1:9032
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"
BIN="$ROOT/axl/bin/node"

mkdir -p "$LOGS"

# ── Prerequisites check ───────────────────────────────────────────────────────
if [ ! -x "$BIN" ]; then
  echo "ERROR: AXL binary not found at $BIN"
  echo "Build it first:"
  echo "  cd axl"
  echo "  git clone --depth 1 https://github.com/gensyn-ai/axl upstream"
  echo "  cd upstream && make build && cd .."
  echo "  mkdir -p bin && cp upstream/node bin/node"
  exit 1
fi

for NODE in nodeA nodeB nodeC nodeS; do
  if [ ! -f "$ROOT/axl/data/$NODE/private.pem" ]; then
    echo "ERROR: Missing key for $NODE. Generate keys first:"
    echo "  cd axl"
    echo "  for n in nodeA nodeB nodeC nodeS; do"
    echo "    openssl genpkey -algorithm ed25519 -out data/\$n/private.pem"
    echo "  done"
    exit 1
  fi
done

# ── Optional kill flag ────────────────────────────────────────────────────────
if [[ "${1:-}" == "--kill" ]]; then
  echo "[start-nodes] Killing existing AXL nodes and agents..."
  pkill -f "axl/bin/node" 2>/dev/null || true
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  sleep 1
fi

# ── Start 4 nodes ─────────────────────────────────────────────────────────────
declare -A PORTS=(
  [nodeA]=9002
  [nodeB]=9012
  [nodeC]=9022
  [nodeS]=9032
)

echo "[start-nodes] Starting 4 AXL nodes..."

for NODE in nodeA nodeB nodeC nodeS; do
  PORT="${PORTS[$NODE]}"
  LOGFILE="$LOGS/axl-$NODE.log"

  # Check if already running on this port
  if curl -sf "http://127.0.0.1:$PORT/topology" > /dev/null 2>&1; then
    echo "  $NODE already running on :$PORT — skipping"
    continue
  fi

  echo "  Starting $NODE (api_port=$PORT) → $LOGFILE"
  (
    cd "$ROOT/axl/data/$NODE"
    exec "$BIN" -config node-config.json
  ) >> "$LOGFILE" 2>&1 &
  disown
  sleep 0.3
done

# ── Wait for all 4 to come up ─────────────────────────────────────────────────
echo ""
echo "[start-nodes] Waiting for all 4 nodes to respond (up to 30s)..."

ALL_PORTS=(9002 9012 9022 9032)
ALL_NODES=(nodeA nodeB nodeC nodeS)
DEADLINE=$(($(date +%s) + 30))

for i in "${!ALL_PORTS[@]}"; do
  PORT="${ALL_PORTS[$i]}"
  NODE="${ALL_NODES[$i]}"
  until curl -sf "http://127.0.0.1:$PORT/topology" > /dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "  TIMEOUT: $NODE (:$PORT) did not respond in 30s"
      echo "  Check: $LOGS/axl-$NODE.log"
      exit 1
    fi
    sleep 0.5
  done
  PUBKEY=$(curl -sf "http://127.0.0.1:$PORT/topology" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
  echo "  ✓ $NODE :$PORT  pubkey=${PUBKEY:0:16}..."
done

echo ""
echo "[start-nodes] All 4 AXL nodes are up."
echo ""
echo "Pubkeys (for KNOWN_PEERS):"
for PORT in 9002 9012 9022 9032; do
  KEY=$(curl -sf "http://127.0.0.1:$PORT/topology" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
  echo "  :$PORT  $KEY"
done
echo ""
echo "SELLER_PEER_ID (nodeS):"
curl -sf "http://127.0.0.1:9032/topology" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])"
