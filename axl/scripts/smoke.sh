#!/usr/bin/env bash
# Day-1 spike: send a message from nodeA -> nodeB and confirm nodeB receives it.
set -euo pipefail

A=http://127.0.0.1:9002
B=http://127.0.0.1:9012

echo "==> waiting for both APIs to come up"
for url in "$A/topology" "$B/topology"; do
  for i in $(seq 1 30); do
    if curl -sf "$url" >/dev/null; then break; fi
    sleep 0.5
  done
done

PEER_A=$(curl -sf "$A/topology" | jq -r .our_public_key)
PEER_B=$(curl -sf "$B/topology" | jq -r .our_public_key)
echo "nodeA pubkey: $PEER_A"
echo "nodeB pubkey: $PEER_B"

echo "==> waiting for nodeA to see nodeB in its tree"
for i in $(seq 1 30); do
  if curl -sf "$A/topology" | jq -e --arg k "$PEER_B" '.tree[]? | select(.public_key==$k or .key==$k)' >/dev/null 2>&1; then
    echo "nodeA sees nodeB"; break
  fi
  if curl -sf "$A/topology" | jq -e --arg k "$PEER_B" '[.tree[]? // .peers[]?] | tostring | contains($k)' >/dev/null 2>&1; then
    echo "nodeA references nodeB"; break
  fi
  sleep 0.5
done

MSG="hello-from-A-$(date +%s)"
echo "==> sending: $MSG"
SEND_OUT=$(curl -sf -X POST \
  -H "X-Destination-Peer-Id: $PEER_B" \
  --data-binary "$MSG" \
  -D - "$A/send" -o /dev/null)
echo "$SEND_OUT" | grep -i sent-bytes || true

echo "==> polling nodeB /recv"
for i in $(seq 1 20); do
  RESP=$(curl -s -D /tmp/recv-headers.txt "$B/recv")
  CODE=$(head -1 /tmp/recv-headers.txt | awk '{print $2}')
  if [ "$CODE" = "200" ]; then
    FROM=$(grep -i x-from-peer-id /tmp/recv-headers.txt | awk '{print $2}' | tr -d '\r')
    echo "nodeB received: '$RESP' from $FROM"
    if [ "$RESP" = "$MSG" ]; then
      echo "PASS: round-trip works"
      exit 0
    else
      echo "FAIL: got unexpected payload"; exit 1
    fi
  fi
  sleep 0.5
done

echo "FAIL: nodeB never received message"
exit 1
