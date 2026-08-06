# ArcVault Intake & Triage Pipeline

AI-powered intake, classification, enrichment, and routing of unstructured
inbound customer requests. Built for the Valsoft AI Engineer technical
assessment.

Five synthetic inbound messages arrive by webhook, are classified and enriched by
an LLM, then deterministically routed to one of five queues — with low-confidence
and high-severity records diverted to a human escalation queue.

## Stack

| Piece | Choice |
|---|---|
| Orchestration | n8n 2.31.6, self-hosted in Docker |
| LLM | DeepSeek `deepseek-v4-flash` |
| Output | Google Sheets (two tabs) + per-record JSON |
| Tests | Node.js 24 built-in test runner, zero dependencies |

## Prerequisites

- Docker Desktop running, with n8n reachable at `http://localhost:5678`
- Node.js 24+
- A DeepSeek API key (only for `scripts/validate-prompts.mjs`; n8n uses its own
  stored credential)

## Setup

```bash
cp .env.example .env   # then fill in the keys
npm test               # routing and escalation logic
```

## Running the pipeline

With the workflow active in n8n:

```bash
bash scripts/send-samples.sh
```

Each sample is POSTed to `http://localhost:5678/webhook/intake` as a separate
event. Records are appended to the Google Sheet — the `Routed` tab or the
`Escalation` tab — and the workflow returns each completed record in the webhook
response, which the script saves to `data/records/`.

To produce the JSON deliverable from that run:

```bash
bash scripts/merge-records.sh   # writes output.json
```

## Layout

| Path | What it is |
|---|---|
| `lib/triage.js` | Routing + escalation logic — the single source of truth |
| `lib/triage.test.js` | Unit tests for the above |
| `prompts/` | Both LLM prompts, each with its rationale |
| `workflow.json` | The importable n8n workflow (built artifact) |
| `scripts/build-workflow.mjs` | Builds `workflow.json`, injecting the logic and prompts |
| `scripts/validate-prompts.mjs` | Exercises both prompts against DeepSeek directly |
| `samples/inbound.json` | The five synthetic test messages |
| `output.json` | Structured output for all five samples |
| `WRITEUP.md` | Architecture write-up |
| `docs/superpowers/specs/` | Design spec |
| `docs/superpowers/plans/` | Implementation plan |

## Why the logic lives outside n8n

`lib/triage.js` holds all routing and escalation rules and is unit-tested with
`npm test`. `scripts/build-workflow.mjs` injects it into the workflow's Code node
at build time.

Logic buried in a visual node cannot be tested, reviewed, or diffed. Keeping it
in a real module means the rules that decide where a customer's request goes have
actual test coverage — including the case that a keyword-only escalation rule
would silently miss.
