#!/usr/bin/env bash
#
# Sends each sample from samples/inbound.json to the n8n intake webhook as a
# separate POST, one second apart. Five independent events, not a batch — the
# pipeline is meant to fire per inbound message.
#
# Usage:  bash scripts/send-samples.sh
#         WEBHOOK_URL=http://host:5678/webhook/intake bash scripts/send-samples.sh

set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:5678/webhook/intake}"

cd "$(dirname "$0")/.."

if [ ! -f samples/inbound.json ]; then
  echo "samples/inbound.json not found" >&2
  exit 1
fi

mapfile -t payloads < <(node --input-type=module -e "
import fs from 'node:fs';
const samples = JSON.parse(fs.readFileSync('samples/inbound.json', 'utf8'));
for (const s of samples) {
  console.log(JSON.stringify({ source: s.source, raw_message: s.raw_message }));
}
")

echo "Sending ${#payloads[@]} samples to ${WEBHOOK_URL}"
echo

i=0
for payload in "${payloads[@]}"; do
  i=$((i + 1))
  echo "--> Sample ${i}"
  curl -sS -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$payload"
  echo
  echo
  sleep 1
done

echo "All ${#payloads[@]} samples sent."
