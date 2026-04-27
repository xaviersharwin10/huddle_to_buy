#!/usr/bin/env bash
# Usage: ./run-node.sh <nodeA|nodeB|nodeC|nodeS>
set -euo pipefail

NODE=${1:?usage: run-node.sh <nodeA|nodeB|nodeC|nodeS>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -x "$ROOT/bin/node" ]; then
  echo "ERROR: missing AXL binary at $ROOT/bin/node"
  echo "Build it first:"
  echo "  cd axl"
  echo "  git clone --depth 1 https://github.com/gensyn-ai/axl upstream"
  echo "  cd upstream && make build && cd .."
  echo "  mkdir -p bin && cp upstream/node bin/node"
  exit 1
fi

if [ ! -f "$ROOT/data/$NODE/private.pem" ]; then
  echo "ERROR: missing private key: $ROOT/data/$NODE/private.pem"
  echo "Generate keys first:"
  echo "  cd axl"
  echo "  for n in nodeA nodeB nodeC nodeS; do openssl genpkey -algorithm ed25519 -out data/\$n/private.pem; done"
  exit 1
fi

cd "$ROOT/data/$NODE"
exec "$ROOT/bin/node" -config node-config.json
