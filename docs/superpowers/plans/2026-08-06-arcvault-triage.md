# ArcVault Intake & Triage Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working n8n workflow that ingests, classifies, enriches, routes, persists, and escalates five synthetic ArcVault customer requests, plus the four assessment deliverables.

**Architecture:** Webhook-triggered linear n8n pipeline. Two DeepSeek calls (classify, then enrich+summarize) followed by deterministic routing/escalation logic. Records land in a two-tab Google Sheet and as per-record JSON files. The routing logic is authored as a unit-tested JS module and injected into the n8n Code node at build time, so the business logic is testable outside n8n.

**Tech Stack:** n8n (Docker), DeepSeek `deepseek-v4-flash`, Google Sheets (service account), Node.js 24 (`node --test`, zero dependencies), bash/curl.

## Global Constraints

- Free / open-source tooling only. DeepSeek is pay-as-you-go but costs <$0.01 for this run.
- Model: `deepseek-v4-flash`. Base URL `https://api.deepseek.com`. Endpoint `/chat/completions`.
- JSON mode requires `response_format: {"type":"json_object"}`, the literal word "json" in the prompt, a structure example in the prompt, and an explicit `max_tokens`.
- Categories, exactly these five: `Bug Report`, `Feature Request`, `Billing Issue`, `Technical Question`, `Incident/Outage`.
- Priorities, exactly these three: `Low`, `Medium`, `High`.
- Queues: `Engineering`, `Product`, `Billing`, `IT/Security`, `General Triage`.
- `CONFIDENCE_THRESHOLD = 0.70`, `BILLING_THRESHOLD = 500`.
- No secrets in git. `.env` and `service-account*.json` are gitignored.
- Node.js is ESM (`"type": "module"` in package.json).
- Timebox: 3–5 hours total. Do not add scope beyond this plan.

### Pre-existing environment (verified 2026-08-06)

n8n **2.31.6** is already running in a container named `n8n` on port 5678. It was
started by the user, not by this project's compose file.

- **Reuse the existing DeepSeek credential** — type `deepSeekApi`, id
  `uhvZCPtk6lRdNwuz`, name `DeepSeek account`. Do not create a new one. HTTP
  Request nodes attach it via `authentication: predefinedCredentialType`,
  `nodeCredentialType: deepSeekApi`.
- A Google OAuth client already exists (a `googleSheetsTriggerOAuth2Api`
  credential is in use). The regular Sheets node needs the *separate*
  `googleSheetsOAuth2Api` type, but the underlying OAuth app is already
  configured, so this is a short re-authorization rather than a new setup.
- **The container has no host bind mount** — only the named volume `n8n_data` at
  `/home/node/.n8n`. Record files are therefore written inside that volume and
  copied out with `docker cp`. Do not recreate the container: workflow
  `fWsOQOQtqvCaTJMn` is active and polling every minute.

---

## File Structure

| Path | Responsibility |
|---|---|
| `docker-compose.yml` | Runs n8n, mounts `./data` into the container |
| `package.json` | ESM marker + `npm test` script |
| `samples/inbound.json` | The five synthetic messages |
| `scripts/send-samples.sh` | POSTs each sample to the webhook |
| `lib/triage.js` | Routing + escalation logic (single source of truth) |
| `lib/triage.test.js` | Unit tests for the above |
| `prompts/01-classification.md` | Classification prompt + rationale |
| `prompts/02-enrichment.md` | Enrichment/summary prompt + rationale |
| `scripts/test-prompts.mjs` | Calls DeepSeek directly to validate prompts pre-n8n |
| `scripts/build-workflow.mjs` | Injects `lib/triage.js` into the workflow template |
| `workflow.template.json` | n8n workflow with a placeholder for the logic |
| `workflow.json` | Built artifact — the importable deliverable |
| `scripts/merge-records.sh` | Merges per-record JSON into `output.json` |
| `WRITEUP.md` | Deliverable 4.4 |
| `README.md` | How to run it |

---

## Task 1: Scaffolding, samples, and a running n8n

**Files:**
- Create: `package.json`, `docker-compose.yml`, `samples/inbound.json`, `scripts/send-samples.sh`, `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: n8n reachable at `http://localhost:5678`; `samples/inbound.json` as an array of `{ id, source, raw_message }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "arcvault-triage",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test lib/",
    "build": "node scripts/build-workflow.mjs"
  }
}
```

- [ ] **Step 2: Create `docker-compose.yml`** *(reference only — do not run it)*

n8n is already running from a container the user started. This file documents a
reproducible setup for the reviewer and is **not** used in this build. Running
`docker compose up` would collide on port 5678.

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    container_name: arcvault-n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      - GENERIC_TIMEZONE=America/Toronto
      - TZ=America/Toronto
      - N8N_SECURE_COOKIE=false
      - N8N_RUNNERS_ENABLED=true
      - N8N_DIAGNOSTICS_ENABLED=false
    volumes:
      - n8n_data:/home/node/.n8n
      - ./data:/data

volumes:
  n8n_data:
```

- [ ] **Step 3: Create `samples/inbound.json`** — verbatim from the assessment, no paraphrasing

```json
[
  {
    "id": 1,
    "source": "Email",
    "raw_message": "Hi, I tried logging in this morning and keep getting a 403 error. My account is arcvault.io/user/jsmith. This started after your update last Tuesday."
  },
  {
    "id": 2,
    "source": "Web Form",
    "raw_message": "We'd love to see a bulk export feature for our audit logs. We're a compliance-heavy org and this would save us hours every month."
  },
  {
    "id": 3,
    "source": "Support Portal",
    "raw_message": "Invoice #8821 shows a charge of $1,240 but our contract rate is $980/month. Can someone look into this?"
  },
  {
    "id": 4,
    "source": "Email",
    "raw_message": "I'm not sure if this is the right place to ask, but is there a way to set up SSO with Okta? We're evaluating switching our auth provider."
  },
  {
    "id": 5,
    "source": "Web Form",
    "raw_message": "Your dashboard stopped loading for us around 2pm EST. Checked our end — it's definitely on yours. Multiple users affected."
  }
]
```

- [ ] **Step 4: Create `scripts/send-samples.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:5678/webhook/intake}"

count=$(node -e "console.log(require('./samples/inbound.json').length)" 2>/dev/null \
  || node --input-type=module -e "import fs from 'fs'; console.log(JSON.parse(fs.readFileSync('samples/inbound.json')).length)")

for i in $(seq 0 $((count - 1))); do
  payload=$(node --input-type=module -e "
    import fs from 'fs';
    const s = JSON.parse(fs.readFileSync('samples/inbound.json'))[$i];
    process.stdout.write(JSON.stringify({ source: s.source, raw_message: s.raw_message }));
  ")
  echo "--> Sending sample $((i + 1))"
  curl -sS -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$payload"
  echo
  sleep 1
done

echo "All samples sent."
```

- [ ] **Step 5: Confirm the running n8n and API key** *(already verified)*

```bash
curl -sS -o /dev/null -w 'healthz: %{http_code}\n' http://localhost:5678/healthz
set -a && source .env && set +a
curl -sS -o /dev/null -w 'api: %{http_code}\n' \
  -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows?limit=1
```

Expected: `healthz: 200`, `api: 200`.

- [ ] **Step 6: Create the record output directory inside the container**

The container has no host bind mount, so records are written inside the n8n data
volume and copied out later.

```bash
docker exec n8n mkdir -p /home/node/.n8n/arcvault-records
docker exec n8n sh -c 'touch /home/node/.n8n/arcvault-records/.probe && ls -la /home/node/.n8n/arcvault-records'
```

Expected: the directory lists and `.probe` exists, confirming it is writable by
the n8n process.

- [ ] **Step 7: Commit**

```bash
git add package.json docker-compose.yml samples/ scripts/send-samples.sh README.md
git commit -m "feat: scaffold project, sample data, and n8n compose setup"
```

---

## Task 2: Routing and escalation logic (TDD)

This is the assessment's System Design Thinking weight (20%). It is pure, deterministic, and fully unit-tested outside n8n.

**Files:**
- Create: `lib/triage.js`, `lib/triage.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CATEGORIES: string[]`, `QUEUES: Record<string,string>`, `CONFIDENCE_THRESHOLD: number`, `BILLING_THRESHOLD: number`
  - `isSecurityRelated(text: string): boolean`
  - `maxCurrencyAmount(text: string): number`
  - `routeRecord({ category: string, raw_message: string }): string`
  - `evaluateEscalation({ category, confidence, raw_message, parse_failed }): { escalation_flag: boolean, escalation_reasons: string[] }`
  - `makeRecordId(now?: Date, rand?: () => number): string`
  - `buildRecord({ source, raw_message, classification, enrichment, parse_failed, now, rand }): object`

- [ ] **Step 1: Write the failing tests**

Create `lib/triage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUES,
  isSecurityRelated,
  maxCurrencyAmount,
  routeRecord,
  evaluateEscalation,
  makeRecordId,
  buildRecord,
} from './triage.js';

const SAMPLE_1 = 'Hi, I tried logging in this morning and keep getting a 403 error. My account is arcvault.io/user/jsmith. This started after your update last Tuesday.';
const SAMPLE_3 = 'Invoice #8821 shows a charge of $1,240 but our contract rate is $980/month. Can someone look into this?';
const SAMPLE_4 = "I'm not sure if this is the right place to ask, but is there a way to set up SSO with Okta? We're evaluating switching our auth provider.";
const SAMPLE_5 = 'Your dashboard stopped loading for us around 2pm EST. Checked our end — it\'s definitely on yours. Multiple users affected.';

test('maxCurrencyAmount picks the largest amount and strips commas', () => {
  assert.equal(maxCurrencyAmount(SAMPLE_3), 1240);
  assert.equal(maxCurrencyAmount('no money here'), 0);
  assert.equal(maxCurrencyAmount('$99.50 and $12'), 99.5);
});

test('isSecurityRelated detects identity/auth vocabulary', () => {
  assert.equal(isSecurityRelated(SAMPLE_4), true);
  assert.equal(isSecurityRelated('We want a bulk export feature'), false);
});

test('isSecurityRelated does not fire on the word "logging in"', () => {
  assert.equal(isSecurityRelated(SAMPLE_1), false);
});

test('routeRecord maps each category to its queue', () => {
  assert.equal(routeRecord({ category: 'Bug Report', raw_message: '' }), QUEUES.ENGINEERING);
  assert.equal(routeRecord({ category: 'Incident/Outage', raw_message: '' }), QUEUES.ENGINEERING);
  assert.equal(routeRecord({ category: 'Feature Request', raw_message: '' }), QUEUES.PRODUCT);
  assert.equal(routeRecord({ category: 'Billing Issue', raw_message: '' }), QUEUES.BILLING);
});

test('routeRecord sends security-flavoured Technical Questions to IT/Security', () => {
  assert.equal(routeRecord({ category: 'Technical Question', raw_message: SAMPLE_4 }), QUEUES.IT_SECURITY);
});

test('routeRecord sends other Technical Questions to Product', () => {
  assert.equal(routeRecord({ category: 'Technical Question', raw_message: 'How do I change the chart colours?' }), QUEUES.PRODUCT);
});

test('routeRecord falls back for an unknown category', () => {
  assert.equal(routeRecord({ category: 'Banana', raw_message: '' }), QUEUES.FALLBACK);
});

test('escalates on low confidence', () => {
  const r = evaluateEscalation({ category: 'Bug Report', confidence: 0.4, raw_message: '' });
  assert.equal(r.escalation_flag, true);
  assert.ok(r.escalation_reasons.includes('low_confidence'));
});

test('does not escalate a confident, ordinary bug report', () => {
  const r = evaluateEscalation({ category: 'Bug Report', confidence: 0.95, raw_message: SAMPLE_1 });
  assert.equal(r.escalation_flag, false);
  assert.deepEqual(r.escalation_reasons, []);
});

test('0.70 confidence is not escalated but 0.699 is', () => {
  assert.equal(evaluateEscalation({ category: 'Bug Report', confidence: 0.7, raw_message: '' }).escalation_flag, false);
  assert.equal(evaluateEscalation({ category: 'Bug Report', confidence: 0.699, raw_message: '' }).escalation_flag, true);
});

test('sample 5 escalates on category even though it never says "outage"', () => {
  assert.equal(/outage/i.test(SAMPLE_5), false, 'guard: sample 5 must not contain the literal word');
  const r = evaluateEscalation({ category: 'Incident/Outage', confidence: 0.93, raw_message: SAMPLE_5 });
  assert.equal(r.escalation_flag, true);
  assert.ok(r.escalation_reasons.includes('incident_category'));
});

test('outage keywords escalate even when the category missed it', () => {
  const r = evaluateEscalation({ category: 'Bug Report', confidence: 0.9, raw_message: 'the service is down for all users' });
  assert.ok(r.escalation_reasons.includes('outage_keyword'));
});

test('sample 3 escalates on the billing threshold', () => {
  const r = evaluateEscalation({ category: 'Billing Issue', confidence: 0.9, raw_message: SAMPLE_3 });
  assert.equal(r.escalation_flag, true);
  assert.ok(r.escalation_reasons.includes('billing_threshold'));
});

test('a small billing dispute does not escalate', () => {
  const r = evaluateEscalation({ category: 'Billing Issue', confidence: 0.9, raw_message: 'I was charged $40 twice.' });
  assert.equal(r.escalation_flag, false);
});

test('the billing threshold only applies to Billing Issues', () => {
  const r = evaluateEscalation({ category: 'Feature Request', confidence: 0.9, raw_message: 'this would save us $5,000 a year' });
  assert.equal(r.escalation_flag, false);
});

test('multiple reasons are all recorded', () => {
  const r = evaluateEscalation({ category: 'Billing Issue', confidence: 0.3, raw_message: SAMPLE_3 });
  assert.deepEqual(r.escalation_reasons.sort(), ['billing_threshold', 'low_confidence']);
});

test('unknown category escalates', () => {
  const r = evaluateEscalation({ category: 'Banana', confidence: 0.99, raw_message: '' });
  assert.ok(r.escalation_reasons.includes('unknown_category'));
});

test('parse failure short-circuits to a single reason', () => {
  const r = evaluateEscalation({ category: undefined, confidence: undefined, raw_message: SAMPLE_3, parse_failed: true });
  assert.equal(r.escalation_flag, true);
  assert.deepEqual(r.escalation_reasons, ['llm_parse_failure']);
});

test('makeRecordId is deterministic given now and rand', () => {
  const id = makeRecordId(new Date('2026-08-06T14:22:31.123Z'), () => 0.5);
  assert.match(id, /^av-20260806T142231Z-[0-9a-f]{4}$/);
});

test('buildRecord assembles the full schema', () => {
  const rec = buildRecord({
    source: 'Support Portal',
    raw_message: SAMPLE_3,
    classification: { category: 'Billing Issue', priority: 'High', confidence: 0.91 },
    enrichment: {
      core_issue: 'Customer billed above contracted rate.',
      identifiers: ['#8821', '$1,240', '$980/month'],
      urgency_signal: 'Active billing discrepancy on a live invoice.',
      summary: 'A customer reports being overcharged.',
    },
    now: new Date('2026-08-06T14:22:31.123Z'),
    rand: () => 0.5,
  });

  assert.equal(rec.routing_destination, QUEUES.BILLING);
  assert.equal(rec.escalation_flag, true);
  assert.deepEqual(rec.escalation_reasons, ['billing_threshold']);
  assert.equal(rec.received_at, '2026-08-06T14:22:31.123Z');
  assert.equal(rec.category, 'Billing Issue');
  assert.deepEqual(Object.keys(rec).sort(), [
    'category', 'confidence', 'core_issue', 'escalation_flag', 'escalation_reasons',
    'identifiers', 'priority', 'raw_message', 'received_at', 'record_id',
    'routing_destination', 'source', 'summary', 'urgency_signal',
  ]);
});

test('buildRecord on parse failure still produces a complete record', () => {
  const rec = buildRecord({
    source: 'Email',
    raw_message: SAMPLE_1,
    parse_failed: true,
    now: new Date('2026-08-06T14:22:31.123Z'),
    rand: () => 0.5,
  });

  assert.equal(rec.routing_destination, QUEUES.FALLBACK);
  assert.deepEqual(rec.escalation_reasons, ['llm_parse_failure']);
  assert.equal(rec.category, null);
  assert.equal(rec.raw_message, SAMPLE_1);
  assert.deepEqual(rec.identifiers, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './triage.js'`

- [ ] **Step 3: Implement `lib/triage.js`**

The bottom `export { ... }` block is stripped by the build script in Task 4, so everything above it must be valid standalone script code — no top-level `import`, no `export` keywords on declarations.

```js
const CATEGORIES = [
  'Bug Report',
  'Feature Request',
  'Billing Issue',
  'Technical Question',
  'Incident/Outage',
];

const QUEUES = {
  ENGINEERING: 'Engineering',
  PRODUCT: 'Product',
  BILLING: 'Billing',
  IT_SECURITY: 'IT/Security',
  FALLBACK: 'General Triage',
};

const CATEGORY_ROUTES = {
  'Bug Report': QUEUES.ENGINEERING,
  'Incident/Outage': QUEUES.ENGINEERING,
  'Feature Request': QUEUES.PRODUCT,
  'Billing Issue': QUEUES.BILLING,
};

const CONFIDENCE_THRESHOLD = 0.7;
const BILLING_THRESHOLD = 500;

// Scoped to Technical Question only, so "logging in" in a bug report is unaffected.
const SECURITY_TERMS =
  /\b(sso|okta|saml|oauth|mfa|2fa|idp|ldap|scim|auth provider|authentication provider|identity provider|access control|permissions?)\b/i;

// Secondary net only. Category is the primary incident signal — see spec section 6.
const OUTAGE_TERMS =
  /outage|down for all users|all users (are )?(down|affected)|multiple users (are )?(affected|impacted)|service is down|widespread/i;

function isSecurityRelated(text = '') {
  return SECURITY_TERMS.test(text);
}

function maxCurrencyAmount(text = '') {
  const matches = text.match(/\$\s?[\d,]+(?:\.\d{1,2})?/g) || [];
  const amounts = matches
    .map((m) => Number(m.replace(/[$,\s]/g, '')))
    .filter((n) => Number.isFinite(n));
  return amounts.length ? Math.max(...amounts) : 0;
}

function routeRecord({ category, raw_message = '' }) {
  if (category === 'Technical Question') {
    return isSecurityRelated(raw_message) ? QUEUES.IT_SECURITY : QUEUES.PRODUCT;
  }
  return CATEGORY_ROUTES[category] || QUEUES.FALLBACK;
}

function evaluateEscalation({ category, confidence, raw_message = '', parse_failed = false }) {
  // When parsing failed the other signals cannot be trusted, so this is the sole reason.
  if (parse_failed) {
    return { escalation_flag: true, escalation_reasons: ['llm_parse_failure'] };
  }

  const reasons = [];

  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < CONFIDENCE_THRESHOLD) {
    reasons.push('low_confidence');
  }
  if (!CATEGORIES.includes(category)) {
    reasons.push('unknown_category');
  }
  if (category === 'Incident/Outage') {
    reasons.push('incident_category');
  }
  if (OUTAGE_TERMS.test(raw_message)) {
    reasons.push('outage_keyword');
  }
  if (category === 'Billing Issue' && maxCurrencyAmount(raw_message) > BILLING_THRESHOLD) {
    reasons.push('billing_threshold');
  }

  return { escalation_flag: reasons.length > 0, escalation_reasons: reasons };
}

function makeRecordId(now = new Date(), rand = Math.random) {
  const ts = now.toISOString().replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
  const suffix = Math.floor(rand() * 0xffff).toString(16).padStart(4, '0');
  return `av-${ts}-${suffix}`;
}

function buildRecord({
  source,
  raw_message,
  classification = {},
  enrichment = {},
  parse_failed = false,
  now = new Date(),
  rand = Math.random,
}) {
  const category = classification.category;
  const { escalation_flag, escalation_reasons } = evaluateEscalation({
    category,
    confidence: classification.confidence,
    raw_message,
    parse_failed,
  });

  return {
    record_id: makeRecordId(now, rand),
    received_at: now.toISOString(),
    source: source ?? null,
    raw_message: raw_message ?? null,
    category: category ?? null,
    priority: classification.priority ?? null,
    confidence: typeof classification.confidence === 'number' ? classification.confidence : null,
    core_issue: enrichment.core_issue ?? null,
    identifiers: Array.isArray(enrichment.identifiers) ? enrichment.identifiers : [],
    urgency_signal: enrichment.urgency_signal ?? null,
    routing_destination: parse_failed ? QUEUES.FALLBACK : routeRecord({ category, raw_message }),
    escalation_flag,
    escalation_reasons,
    summary: enrichment.summary ?? null,
  };
}

export {
  CATEGORIES,
  QUEUES,
  CONFIDENCE_THRESHOLD,
  BILLING_THRESHOLD,
  isSecurityRelated,
  maxCurrencyAmount,
  routeRecord,
  evaluateEscalation,
  makeRecordId,
  buildRecord,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/
git commit -m "feat: add tested routing and escalation logic"
```

---

## Task 3: Prompts, validated directly against DeepSeek

Validate both prompts against the real API *before* wiring them into n8n. Debugging a prompt through the n8n canvas is far slower than through a script.

**Files:**
- Create: `prompts/01-classification.md`, `prompts/02-enrichment.md`, `scripts/test-prompts.mjs`, `.env.example`

**Interfaces:**
- Consumes: `samples/inbound.json` from Task 1
- Produces: two prompt texts used verbatim in Task 4's workflow; `classify(msg)` and `enrich(msg, classification)` shapes proven against the live API

- [ ] **Step 1: Create `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored.
DEEPSEEK_API_KEY=
```

- [ ] **Step 2: Write `prompts/01-classification.md`**

The prompt body is everything inside the fenced block. The rationale below it is deliverable 4.3.

````markdown
# Prompt 1 — Classification

## System prompt

```
You are a support triage classifier for ArcVault, a B2B software company.
Classify a single inbound customer message.

Return json only. No prose, no markdown fences.

Schema:
{
  "category": "Bug Report" | "Feature Request" | "Billing Issue" | "Technical Question" | "Incident/Outage",
  "priority": "Low" | "Medium" | "High",
  "confidence": number between 0 and 1
}

Category definitions:
- Bug Report: something is broken for this customer, and they describe specific incorrect behaviour.
- Feature Request: they are asking for capability that does not exist yet.
- Billing Issue: invoices, charges, pricing, refunds, contract rates.
- Technical Question: they are asking how to do something, or whether something is possible. Nothing is broken.
- Incident/Outage: a service disruption that appears to affect many users, not just the sender.

Bug Report vs Incident/Outage: if the message signals breadth of impact
("multiple users", "everyone", "all our staff", "company-wide"), or describes a
service being unreachable rather than misbehaving, choose Incident/Outage.
A single user blocked is a Bug Report.

Priority:
- High: work is blocked now, money is at risk, or many users are affected.
- Medium: meaningful friction, but the customer has a path forward.
- Low: informational, aspirational, or convenience.

Confidence — use this scale honestly:
- 0.90-1.00: the message states its intent unambiguously; only one category fits.
- 0.70-0.89: the category is clear, but some detail is ambiguous or missing.
- 0.50-0.69: two categories plausibly fit and you picked the better one.
- below 0.50: not enough information to classify with any confidence.
Do not default to a high value. A wrong confident answer is worse than an
honest uncertain one, because a human reviews anything below 0.70.
```

## User prompt

```
Source: {{source}}

Message:
{{raw_message}}
```

## Rationale

This prompt does one job, so the confidence score describes the classification
task alone rather than being diluted across extraction and summarization. The
category definitions are included because "Bug Report" and "Incident/Outage" are
genuinely ambiguous at the boundary — the assessment's own sample 5 sits exactly
there — and the model needs a stated rule rather than a guess. I gave that rule
explicitly in terms of *breadth of impact*, which is the signal that actually
distinguishes the two operationally.

The confidence scale is anchored with descriptions of each band instead of asking
for a bare number. Unanchored self-reported confidence clusters near 0.9
regardless of correctness, and this pipeline gates human escalation on the 0.70
boundary, so a poorly calibrated score directly causes mis-escalation. Anchoring
narrows the problem; it does not solve it. I also tell the model *why* honesty
matters — that a human reviews anything under 0.70 — because giving the stated
consequence measurably reduces confidence inflation.

`temperature: 0` because classification should be reproducible: the same message
must not route differently between two runs.

**Tradeoffs:** the category definitions are my interpretation, not ArcVault's — a
real deployment would derive them from the receiving teams' actual intake
criteria. The prompt also has no few-shot examples; with more time I would add
two or three drawn from genuinely ambiguous historical tickets, which typically
helps boundary cases more than any amount of instruction rewriting.

**With more time:** replace self-reported confidence with self-consistency —
sample the classification three times at temperature 0.3 and use the agreement
rate as the confidence signal. That is a real calibration measurement rather than
the model's opinion of itself. It triples the cost, which is why it is not here.
````

- [ ] **Step 3: Write `prompts/02-enrichment.md`**

````markdown
# Prompt 2 — Enrichment and summary

## System prompt

```
You extract structured detail from an inbound customer support message for
ArcVault, a B2B software company. The message has already been classified.

Return json only. No prose, no markdown fences.

Schema:
{
  "core_issue": "one sentence stating what the customer needs",
  "identifiers": ["array of concrete identifiers quoted from the message"],
  "urgency_signal": "one sentence on what makes this urgent or not, grounded in the message",
  "summary": "2-3 sentences for the team receiving this ticket"
}

Rules:
- identifiers: copy verbatim from the message. Include account names, URLs,
  usernames, invoice numbers, error codes, ticket numbers, dollar amounts,
  product names and timestamps. Return [] if the message contains none.
  Never invent an identifier that is not present in the text.
- urgency_signal: describe evidence from the message, such as scope of impact,
  money at stake, or whether the customer is blocked. Do not restate the priority
  label.
- summary: write for the team that receives this ticket. State what happened,
  what is known, and what they should look at. Do not repeat the raw message
  verbatim and do not open with a greeting.
- Never invent facts. If something is not in the message, leave it out.
```

## User prompt

```
Category: {{category}}
Priority: {{priority}}
Source: {{source}}

Message:
{{raw_message}}
```

## Rationale

Extraction and summarization are combined into one call because they need the
same context and produce the same kind of grounded output — splitting them would
double latency and cost for no gain in quality. Classification stays separate for
the confidence-calibration reason given in prompt 1; this is where I drew the
line between "separate the concerns" and "don't over-engineer".

The classification result is passed in as context so extraction can be
category-aware — a Billing Issue should surface invoice numbers and amounts,
while a Bug Report should surface error codes. The cost of this is coupling: a
misclassification propagates into the enrichment. I accepted it because the
grounding benefit is larger at this scale, but it is the first thing I would
measure in production.

"Never invent an identifier" appears twice, once as a rule and once as a general
constraint, because hallucinated identifiers are the highest-cost failure mode
here — a fabricated invoice number sends a billing agent chasing a record that
does not exist. Repetition of the constraint that matters most is deliberate.

`temperature: 0.3` rather than 0, because the summary is prose and fully greedy
decoding tends to produce stilted, repetitive sentences. Extraction is
constrained enough by the "copy verbatim" instruction that the small temperature
does not put identifier fidelity at risk.

**Tradeoffs:** `identifiers` is a flat array of strings rather than typed
key/value pairs. Typed extraction (`{"invoice": "#8821"}`) would be more useful
downstream, but it needs a per-category schema, and at five sample messages the
flat list is honest about what is actually known. I would type it before this
went anywhere near a real queue.
````

- [ ] **Step 4: Write `scripts/test-prompts.mjs`**

```js
import fs from 'node:fs';
import { buildRecord } from '../lib/triage.js';

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set. Copy .env.example to .env and fill it in, then:');
  console.error('  set -a && source .env && set +a && node scripts/test-prompts.mjs');
  process.exit(1);
}

const CLASSIFY_SYSTEM = fs.readFileSync('prompts/01-classification.md', 'utf8')
  .split('```')[1].trim();
const ENRICH_SYSTEM = fs.readFileSync('prompts/02-enrichment.md', 'utf8')
  .split('```')[1].trim();

async function callDeepSeek({ system, user, temperature, maxTokens }) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new Error('DeepSeek returned empty content');
  }
  return JSON.parse(content);
}

const samples = JSON.parse(fs.readFileSync('samples/inbound.json', 'utf8'));
const records = [];

for (const s of samples) {
  process.stderr.write(`Processing sample ${s.id}...\n`);
  let classification = {};
  let enrichment = {};
  let parse_failed = false;

  try {
    classification = await callDeepSeek({
      system: CLASSIFY_SYSTEM,
      user: `Source: ${s.source}\n\nMessage:\n${s.raw_message}`,
      temperature: 0,
      maxTokens: 200,
    });

    enrichment = await callDeepSeek({
      system: ENRICH_SYSTEM,
      user: `Category: ${classification.category}\nPriority: ${classification.priority}\nSource: ${s.source}\n\nMessage:\n${s.raw_message}`,
      temperature: 0.3,
      maxTokens: 600,
    });
  } catch (err) {
    process.stderr.write(`  FAILED: ${err.message}\n`);
    parse_failed = true;
  }

  records.push(buildRecord({
    source: s.source,
    raw_message: s.raw_message,
    classification,
    enrichment,
    parse_failed,
  }));
}

console.log(JSON.stringify(records, null, 2));

console.error('\n--- Summary ---');
for (const r of records) {
  console.error(
    `${String(r.category).padEnd(20)} ${String(r.priority).padEnd(7)} ` +
    `conf=${r.confidence} -> ${String(r.routing_destination).padEnd(14)} ` +
    `${r.escalation_flag ? 'ESCALATED (' + r.escalation_reasons.join(', ') + ')' : ''}`
  );
}
```

- [ ] **Step 5: Create `.env` with the real key**

This step is the user's — the key must not pass through the transcript.

```bash
cp .env.example .env
# then edit .env and paste the DeepSeek key
```

- [ ] **Step 6: Run the prompt validation**

Run: `set -a && source .env && set +a && node scripts/test-prompts.mjs > /tmp/prompt-check.json`

Expected on stderr, matching spec section 9:

```
Bug Report           Medium  conf=0.9x -> Engineering
Feature Request      Low     conf=0.9x -> Product
Billing Issue        High    conf=0.9x -> Billing        ESCALATED (billing_threshold)
Technical Question   Low     conf=0.8x -> IT/Security
Incident/Outage      High    conf=0.9x -> Engineering    ESCALATED (incident_category)
```

Categories and destinations must match exactly. Priority and confidence may vary
slightly — that is expected model variance, not a failure. If a **category** is
wrong, revise the relevant prompt's category definitions and re-run before
continuing. Do not proceed to Task 4 with a misclassifying prompt.

- [ ] **Step 7: Commit**

```bash
git add prompts/ scripts/test-prompts.mjs .env.example
git commit -m "feat: add classification and enrichment prompts with validation harness"
```

---

## Task 4: Build and deploy the n8n workflow

**Files:**
- Create: `workflow.template.json`, `scripts/build-workflow.mjs`
- Generated: `workflow.json`

**Interfaces:**
- Consumes: `lib/triage.js` (Task 2), the two prompt bodies (Task 3)
- Produces: an active workflow at `POST http://localhost:5678/webhook/intake`

- [ ] **Step 1: Confirm the n8n API key is in `.env`** *(already done)*

`N8N_API_KEY` is set. Local-only key for `localhost:5678`.

- [ ] **Step 2: Reuse the existing DeepSeek credential** *(no new credential needed)*

The `deepSeekApi` credential `uhvZCPtk6lRdNwuz` ("DeepSeek account") already
exists. Both HTTP Request nodes reference it by id:

```json
"authentication": "predefinedCredentialType",
"nodeCredentialType": "deepSeekApi",
"credentials": {
  "deepSeekApi": { "id": "uhvZCPtk6lRdNwuz", "name": "DeepSeek account" }
}
```

`predefinedCredentialType` on a generic HTTP Request node gives full control over
`response_format`, `temperature`, and `max_tokens` — which the LangChain
`lmChatDeepSeek` node abstracts away — while still reusing the stored key. The
raw key never touches the repo.

- [ ] **Step 3: Write `scripts/build-workflow.mjs`**

```js
import fs from 'node:fs';

const LOGIC_MARKER = '/* __TRIAGE_LOGIC__ */';

const logic = fs.readFileSync('lib/triage.js', 'utf8')
  // Strip the trailing ESM export block; everything above it is plain script code.
  .replace(/export\s*\{[\s\S]*?\};\s*$/m, '')
  .trim();

const template = fs.readFileSync('workflow.template.json', 'utf8');

if (!template.includes(LOGIC_MARKER)) {
  console.error(`Marker ${LOGIC_MARKER} not found in workflow.template.json`);
  process.exit(1);
}

// JSON.stringify then slice the surrounding quotes, to escape the code for embedding.
const escaped = JSON.stringify(logic).slice(1, -1);
const built = template.replaceAll(LOGIC_MARKER, escaped);

JSON.parse(built); // fail loudly if the substitution produced invalid JSON

fs.writeFileSync('workflow.json', built);
console.log('Wrote workflow.json');
```

- [ ] **Step 4: Author `workflow.template.json`**

Build the node graph below. `Route & Escalate` contains the `__TRIAGE_LOGIC__`
marker; every other node is authored directly.

| # | Node name | Type | Key parameters |
|---|---|---|---|
| 1 | `Intake Webhook` | `n8n-nodes-base.webhook` | `httpMethod: POST`, `path: intake`, `responseMode: lastNode` |
| 2 | `Classify` | `n8n-nodes-base.httpRequest` | POST `https://api.deepseek.com/chat/completions`, `predefinedCredentialType` → `deepSeekApi` (`uhvZCPtk6lRdNwuz`), JSON body below, `retryOnFail: true`, `maxTries: 2`, `waitBetweenTries: 2000`, `onError: continueRegularOutput` |
| 3 | `Enrich & Summarize` | `n8n-nodes-base.httpRequest` | same endpoint/cred, body below, same retry settings |
| 4 | `Route & Escalate` | `n8n-nodes-base.code` | `mode: runOnceForAllItems`, JS below |
| 5 | `Is Escalated?` | `n8n-nodes-base.if` | condition: boolean `={{ $json.escalation_flag }}` is true |
| 6 | `Sheet: Escalation` | `n8n-nodes-base.googleSheets` | Task 5 |
| 7 | `Sheet: Routed` | `n8n-nodes-base.googleSheets` | Task 5 |
| 8 | `To File` | `n8n-nodes-base.convertToFile` | `operation: toJson`, `mode: each` |
| 9 | `Write Record` | `n8n-nodes-base.readWriteFile` | `operation: write`, `fileName: =/home/node/.n8n/arcvault-records/{{ $json.record_id }}.json` |

Connections: 1→2→3→4→5; 5(true)→6, 5(false)→7; 6→8 and 7→8; 8→9.

`Classify` request body (`specifyBody: json`):

```
={{ JSON.stringify({
  model: "deepseek-v4-flash",
  temperature: 0,
  max_tokens: 200,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: $json.CLASSIFY_SYSTEM_PROMPT },
    { role: "user", content: "Source: " + $json.source + "\n\nMessage:\n" + $json.raw_message }
  ]
}) }}
```

Inline the literal system prompt text from `prompts/01-classification.md` in
place of `$json.CLASSIFY_SYSTEM_PROMPT`, and the text from
`prompts/02-enrichment.md` for the enrichment node. The prompt files remain the
documentation of record; the workflow carries the same text verbatim.

`Route & Escalate` code:

```js
/* __TRIAGE_LOGIC__ */

const items = $input.all();
const webhookBody = $('Intake Webhook').first().json.body;
const source = webhookBody.source;
const raw_message = webhookBody.raw_message;

function safeParse(node) {
  try {
    const content = $(node).first().json.choices?.[0]?.message?.content;
    if (!content || !content.trim()) return null;
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

const classification = safeParse('Classify');
const enrichment = safeParse('Enrich & Summarize');
const parse_failed = classification === null || enrichment === null;

const record = buildRecord({
  source,
  raw_message,
  classification: classification || {},
  enrichment: enrichment || {},
  parse_failed,
});

// Flatten arrays for the Google Sheets cells; the JSON file keeps the real arrays.
return [{
  json: {
    ...record,
    identifiers_text: record.identifiers.join('; '),
    escalation_reasons_text: record.escalation_reasons.join('; '),
  },
}];
```

- [ ] **Step 5: Build the workflow**

Run: `npm run build`
Expected: `Wrote workflow.json` with no JSON parse error.

- [ ] **Step 6: Push the workflow into n8n via the REST API**

```bash
set -a && source .env && set +a
curl -sS -X POST http://localhost:5678/api/v1/workflows \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @workflow.json | head -c 400
```

Expected: a JSON response containing an `"id"`.

If the API rejects the payload, strip read-only top-level keys (`active`, `id`,
`tags`, `pinData`) and retry — the create endpoint accepts only `name`, `nodes`,
`connections`, and `settings`.

- [ ] **Step 7: Open the workflow in the UI and verify it rendered**

Confirm all nine nodes appear, connections match the graph above, and the two
HTTP nodes show the `DeepSeek API` credential attached. Attach it manually if
not — credentials are referenced by ID and may not bind on import.

Any node that fails to import should be added by hand using its row in the Step 4
table. Do not skip a node to save time.

- [ ] **Step 8: Activate the workflow**

Toggle **Active** in the UI. The production webhook path
`http://localhost:5678/webhook/intake` only exists while active.

- [ ] **Step 9: Smoke-test with one message**

```bash
curl -sS -X POST http://localhost:5678/webhook/intake \
  -H 'Content-Type: application/json' \
  -d '{"source":"Email","raw_message":"Invoice #8821 shows a charge of $1,240 but our contract rate is $980/month. Can someone look into this?"}'
```

Expected: a record with `category: "Billing Issue"`, `routing_destination:
"Billing"`, `escalation_flag: true`, `escalation_reasons: ["billing_threshold"]`.
Google Sheets nodes will error until Task 5 — that is expected here.

- [ ] **Step 10: Commit**

```bash
git add workflow.template.json workflow.json scripts/build-workflow.mjs
git commit -m "feat: add n8n workflow with injected triage logic"
```

---

## Task 5: Google Sheets output

**Files:**
- Modify: `workflow.template.json` (nodes 6 and 7), rebuild `workflow.json`

**Interfaces:**
- Consumes: the record shape from Task 4
- Produces: two populated tabs in one spreadsheet

Revised from the spec's service-account approach: a Google OAuth client already
exists in this n8n instance, so OAuth is now the *shorter* path, not the longer
one. The spec's reasoning — avoid a fresh OAuth redirect-URI setup — no longer
applies, because that setup is already done.

- [ ] **Step 1: Add a `googleSheetsOAuth2Api` credential (user, in the browser)**

**Credentials → Add credential → Google Sheets OAuth2 API.**

The existing `Google Sheets Trigger account` credential is type
`googleSheetsTriggerOAuth2Api`, which the regular Sheets node cannot use — n8n
treats trigger and action Google credentials as separate types. Reuse the same
Client ID and Client Secret from the existing Google Cloud OAuth app, then click
**Connect** and authorize.

If the OAuth consent screen rejects the redirect, add
`http://localhost:5678/rest/oauth2-credential/callback` to the OAuth client's
authorized redirect URIs in Google Cloud Console.

Fall back to the spec's service-account approach only if this fails.

- [ ] **Step 2: Create the spreadsheet**

Create a Google Sheet named `ArcVault Triage Output` with two tabs named exactly
`Routed` and `Escalation`, owned by the same Google account being authorized.

Put this header row in **both** tabs, in this order:

```
record_id | received_at | source | category | priority | confidence | core_issue | identifiers_text | urgency_signal | routing_destination | escalation_flag | escalation_reasons_text | summary | raw_message
```

- [ ] **Step 3: Configure both Sheets nodes**

Both nodes: `resource: sheet`, `operation: append`, credential = the
`googleSheetsOAuth2Api` credential from Step 1, document = `ArcVault Triage
Output`, mapping mode = map each column manually, matching the header row from
Step 2. `Sheet: Escalation` targets the `Escalation` tab, `Sheet: Routed` targets
`Routed`.

Map `identifiers_text` and `escalation_reasons_text` (not the raw arrays) into
their columns.

- [ ] **Step 4: Rebuild and update the workflow**

```bash
npm run build
set -a && source .env && set +a
curl -sS -X PUT "http://localhost:5678/api/v1/workflows/$N8N_WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @workflow.json | head -c 200
```

Add `N8N_WORKFLOW_ID` to `.env` using the id returned in Task 4 Step 6.

- [ ] **Step 5: Verify with one escalating message**

Re-run the Task 4 Step 9 curl.
Expected: exactly one new row appears in the **Escalation** tab, none in `Routed`.

- [ ] **Step 6: Clear the test rows**

Delete rows added during smoke-testing so the final run produces exactly five.

- [ ] **Step 7: Commit**

```bash
git add workflow.template.json workflow.json
git commit -m "feat: wire Google Sheets routed and escalation queues"
```

---

## Task 6: Full run and output file

**Files:**
- Create: `scripts/merge-records.sh`, `output.json`

**Interfaces:**
- Consumes: the active workflow
- Produces: `output.json` (deliverable 4.2), five populated sheet rows

- [ ] **Step 1: Clear prior records, host and container**

```bash
rm -f data/records/*.json
docker exec n8n sh -c 'rm -f /home/node/.n8n/arcvault-records/*.json'
```

- [ ] **Step 2: Create `scripts/merge-records.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

node --input-type=module -e "
import fs from 'node:fs';
const dir = 'data/records';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const records = files.map((f) => JSON.parse(fs.readFileSync(\`\${dir}/\${f}\`, 'utf8')));
fs.writeFileSync('output.json', JSON.stringify(records, null, 2) + '\n');
console.error(\`Merged \${records.length} records into output.json\`);
"
```

- [ ] **Step 3: Send all five samples**

Run: `bash scripts/send-samples.sh`
Expected: five `--> Sending sample N` lines, each returning a record JSON.

- [ ] **Step 4: Verify the sheet**

`Routed` has 3 data rows (samples 1, 2, 4). `Escalation` has 2 (samples 3, 5).
All columns populated, no blanks in `summary` or `core_issue`.

- [ ] **Step 5: Copy records out of the container, then merge**

```bash
docker exec n8n sh -c 'ls /home/node/.n8n/arcvault-records/*.json | wc -l'
docker cp n8n:/home/node/.n8n/arcvault-records/. ./data/records/
bash scripts/merge-records.sh
```

Expected: the container lists `5`, and the merge prints `Merged 5 records into
output.json`.

- [ ] **Step 6: Verify against the spec's expected results**

```bash
node --input-type=module -e "
import fs from 'node:fs';
const recs = JSON.parse(fs.readFileSync('output.json','utf8'));
const expected = [
  ['Bug Report','Engineering',false],
  ['Feature Request','Product',false],
  ['Billing Issue','Billing',true],
  ['Technical Question','IT/Security',false],
  ['Incident/Outage','Engineering',true],
];
const byOrder = recs.sort((a,b)=>a.received_at.localeCompare(b.received_at));
let ok = true;
byOrder.forEach((r,i)=>{
  const [cat,dest,esc] = expected[i];
  const pass = r.category===cat && r.routing_destination===dest && r.escalation_flag===esc;
  if(!pass) ok = false;
  console.log(\`\${pass?'PASS':'FAIL'} \${i+1}: \${r.category} -> \${r.routing_destination} esc=\${r.escalation_flag}\`);
});
process.exit(ok?0:1);
"
```

Expected: five `PASS` lines, exit 0.

If a classification differs, do not edit `output.json` by hand. Either accept and
document the divergence in the write-up, or fix the prompt and re-run from Step 1.

- [ ] **Step 7: Commit**

```bash
git add output.json scripts/merge-records.sh
git commit -m "feat: add end-to-end run output for all five samples"
```

---

## Task 7: Deliverables

**Files:**
- Create: `WRITEUP.md`, `docs/screenshots/`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: the four assessment deliverables

- [ ] **Step 1: Capture screenshots**

Save into `docs/screenshots/`: the full canvas, one successful execution showing
all nodes green, the `Classify` node's output panel, the `Route & Escalate`
output panel, and both sheet tabs populated.

- [ ] **Step 2: Write `WRITEUP.md`** (deliverable 4.4, one to two pages)

Sections, in order:

1. **System design** — the node graph, what triggers what, and the statelessness
   decision: no state inside n8n, the sheet and JSON files are the only durable
   state, so every message is independently replayable.
2. **Routing logic** — the category→queue table; why Incident/Outage goes to
   Engineering rather than IT/Security; the Technical Question conditional and
   why sample 4 justifies it; the General Triage fallback.
3. **Escalation logic** — all six criteria. Lead with the sample-5 finding: a
   keyword-only rule, which is the obvious reading of the requirement, misses the
   most escalation-worthy message in the set, so classification is the primary
   signal and keywords are defence in depth. State the `$500` interpretation and
   why over-escalating a billing dispute is the cheaper error.
4. **What the AI got wrong** — they ask this in the interview, so answer it in
   writing. Cover the stale DeepSeek model names (`deepseek-chat` is superseded
   by `deepseek-v4-flash`), and the keyword-escalation bug caught by writing the
   test for sample 5 before trusting the rule.
5. **Production scale** — reliability: the escalation queue doubles as the
   dead-letter queue, and DeepSeek documents that JSON mode can return empty
   content, so this is a real path rather than defensive decoration. Cost: flash
   over pro because the task is not reasoning-heavy. Latency: the two calls are
   sequential because enrichment consumes the classification; a single call
   halves latency at the cost of confidence calibration. Also: idempotency keys
   on retry, and batching for volume.
6. **Phase 2** — typed per-category identifier extraction; self-consistency
   sampling for real confidence calibration; replacing the security keyword match
   with a classifier sub-label; a golden set with accuracy tracking per category.

Be specific about tradeoffs and honest about limits. The assessment weights
Documentation & Communication at 15% and states plainly that reasoning beats
completeness.

- [ ] **Step 3: Update `README.md`**

Cover: prerequisites (Docker, Node 24, a DeepSeek key), setup, `npm test`, how to
run the pipeline, and a file map. Written so a reviewer can reproduce the run
without asking questions.

- [ ] **Step 4: Verify every deliverable exists**

| Req | Artifact | Check |
|---|---|---|
| 4.1 | `workflow.json` + `docs/screenshots/` | files present |
| 4.2 | `output.json` + sheet link | 5 records, all fields populated |
| 4.3 | `prompts/*.md` | both prompts + rationale paragraphs |
| 4.4 | `WRITEUP.md` | all six sections |

- [ ] **Step 5: Final test run**

Run: `npm test`
Expected: all pass, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add WRITEUP.md README.md docs/screenshots/
git commit -m "docs: add architecture write-up and submission deliverables"
```

---

## Out of scope

Excluded deliberately — the assessment penalizes overbuilding and timeboxes at 3–5 hours:

- Vector store / RAG over historical tickets
- Multi-agent or tool-calling architectures
- Automated evaluation harness or golden-set scoring
- Auth, rate limiting, or multi-tenancy on the webhook
- Real email ingestion (Gmail/Mailhog)
- Retry/backoff beyond a single retry

Several belong in the write-up's Phase 2 and production sections, where
describing them costs nothing and demonstrates the same thinking.
