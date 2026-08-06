#!/usr/bin/env bash
#
# Sends each sample from samples/inbound.json to the n8n intake webhook as a
# separate POST, one second apart. Five independent events, not a batch — the
# pipeline is meant to fire per inbound message.
#
# The workflow's Respond node returns the complete record, so each response is
# saved to data/records/ and merged into output.json by scripts/merge-records.sh.
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

mkdir -p data/records

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
failed=0
for payload in "${payloads[@]}"; do
  i=$((i + 1))
  out="data/records/sample-$(printf '%02d' "$i").json"

  status=$(curl -sS -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    -o "$out" \
    -w '%{http_code}')

  if [ "$status" != "200" ]; then
    echo "--> Sample ${i}: HTTP ${status}  FAILED"
    cat "$out"
    echo
    failed=$((failed + 1))
  else
    summary=$(node --input-type=module -e "
      import fs from 'node:fs';
      const r = JSON.parse(fs.readFileSync('$out', 'utf8'));
      const esc = r.escalation_flag ? 'ESCALATED (' + r.escalation_reasons.join(', ') + ')' : '';
      console.log(\`\${String(r.category).padEnd(19)} \${String(r.priority).padEnd(7)} conf=\${String(r.confidence).padEnd(5)} -> \${String(r.routing_destination).padEnd(14)} \${esc}\`);
    ")
    echo "--> Sample ${i}: ${summary}"
  fi

  sleep 1
done

echo
if [ "$failed" -gt 0 ]; then
  echo "${failed} of ${#payloads[@]} samples failed."
  exit 1
fi

echo "All ${#payloads[@]} samples processed. Responses saved to data/records/."
