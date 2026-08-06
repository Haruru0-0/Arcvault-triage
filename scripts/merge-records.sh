#!/usr/bin/env bash
#
# Merges the per-sample responses in data/records/ into output.json
# (deliverable 4.2), ordered by received_at.
#
# Usage: bash scripts/merge-records.sh

set -euo pipefail

cd "$(dirname "$0")/.."

node --input-type=module -e "
import fs from 'node:fs';

const dir = 'data/records';
if (!fs.existsSync(dir)) {
  console.error('data/records/ not found — run scripts/send-samples.sh first');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error('no records in data/records/ — run scripts/send-samples.sh first');
  process.exit(1);
}

const records = files.map((f) => JSON.parse(fs.readFileSync(\`\${dir}/\${f}\`, 'utf8')));
records.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));

// identifiers_text / escalation_reasons_text exist only to flatten arrays into
// Google Sheets cells. The JSON deliverable keeps the real arrays instead.
const cleaned = records.map(({ identifiers_text, escalation_reasons_text, ...rest }) => rest);

fs.writeFileSync('output.json', JSON.stringify(cleaned, null, 2) + '\n');
console.error(\`Merged \${cleaned.length} records into output.json\`);
"
