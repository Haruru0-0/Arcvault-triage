# ArcVault Intake & Triage — Architecture Write-Up

**Ahmad Kanaan** · Valsoft AI Engineer Technical Assessment

Stack: n8n 2.31.6 (self-hosted, Docker) · DeepSeek `deepseek-v4-flash` · Google
Sheets · Node.js 24. Total API cost for a full five-message run: under one cent.

---

## 1. System design

Webhook-triggered linear pipeline, one n8n execution per inbound message.

```
POST /webhook/intake
   → Classify            (DeepSeek call 1)
   → Enrich & Summarize  (DeepSeek call 2)
   → Route & Escalate    (deterministic Code node)
   → Respond             (returns the record to the caller)
   → Is Escalated?       ┬─ true  → Sheets "Escalation" tab
                         └─ false → Sheets "Routed" tab
```

The five samples are sent as five separate POSTs by `scripts/send-samples.sh`, so
the demo exercises real event-driven triggering rather than a batch loop.

**Where state lives: nowhere inside n8n.** Each execution is stateless and
self-contained; the Google Sheet is the only durable store. That makes every
message independently replayable, which matters far more than any efficiency
gained from batching — if one record is wrong, you re-send that message, not the
run.

**Why two LLM calls.** Classification is isolated so its confidence score
describes the classification task alone, rather than being diluted across
extraction and summarization. The cost is coupling: the enrichment call receives
the category as context, so a misclassification propagates and the enriched
record then looks *confidently* wrong rather than obviously wrong. I accepted
that because category-aware extraction is meaningfully better grounded, but it is
the first thing I would measure in production.

**Why the business logic lives outside n8n.** All routing and escalation rules
are in `lib/triage.js`, unit-tested with `npm test` (21 tests), and injected into
the n8n Code node by `scripts/build-workflow.mjs` at build time. The prompts are
injected from `prompts/*.md` the same way. Logic buried in a visual node cannot
be tested, reviewed, or diffed — and the rules deciding where a customer's
request goes deserve test coverage. The build step also means documentation and
runtime cannot drift apart.

---

## 2. Routing logic

Deterministic, no LLM involvement — routing must be auditable and reproducible.

| Category | Queue |
|---|---|
| Bug Report | Engineering |
| Incident/Outage | Engineering |
| Feature Request | Product |
| Billing Issue | Billing |
| Technical Question | IT/Security if security-related, else Product |
| *anything else* | General Triage (+ escalated) |

**Incident/Outage → Engineering, not IT/Security.** An outage of ArcVault's own
dashboard is an engineering/SRE concern. IT/Security owns access, identity and
authentication — a different failure domain.

**The one conditional.** Sample 4 asks about SSO with Okta. A pure
category→queue map sends it to Product, but an auth-provider question belongs
with IT/Security. So Technical Questions are keyword-tested for identity
vocabulary (`sso`, `okta`, `saml`, `oauth`, `mfa`, …), scoped to that category
only so "logging in" in a bug report is unaffected.

Keyword matching is brittle to phrasing and I would not ship it at scale — the
right form is a sub-label from the classifier. It earns its place here because it
is one transparent rule that is demonstrably correct on the assessment's own
sample, and it is covered by tests.

**Nothing is ever dropped.** Any unrecognised category falls back to General
Triage and is escalated.

---

## 3. Escalation logic

`escalation_flag` is true if **any** of: `confidence < 0.70`; category is
`Incident/Outage`; outage keywords match; a Billing Issue mentions more than
$500; the category is unrecognised; or the LLM output failed to parse. All
matching reasons are recorded — `escalation_reasons` is an array, because a
low-confidence billing dispute over $500 has two reasons and a triager benefits
from seeing both.

**The finding that changed the design.** The obvious reading of the requirement
is to escalate on keywords like `outage` or `down for all users`. Sample 5 reads:

> "Your dashboard stopped loading for us around 2pm EST. Checked our end — it's
> definitely on yours. Multiple users affected."

It contains neither phrase. **A keyword-only rule misses the most
escalation-worthy message in the set.** So classification is the primary signal
and keywords are a secondary net for cases the classifier underrates. There is a
test asserting sample 5 contains no outage vocabulary and still escalates, so the
reasoning is pinned rather than remembered.

**A documented assumption.** "Billing error > $500" is ambiguous: in sample 3 the
disputed *delta* is $260 ($1,240 charged vs $980 contracted), while the *amount
in question* is $1,240. I take the maximum currency amount mentioned, because
under-escalating a billing dispute costs more than over-escalating one, and the
delta often is not extractable when a customer states a single figure.

**Failure is an escalation reason, not a crash.** Each HTTP node retries once;
parse failures are caught, and the record is written with the raw message intact,
`routing_destination: "General Triage"`, and reason `llm_parse_failure`. **The
escalation queue doubles as the dead-letter queue** — a failed record lands in
front of a human, which is exactly where an unparseable one belongs. No separate
machinery.

---

## 4. What the AI got wrong

Three things cost real debugging time, and none were visible from reading code.

**Stale model identifiers.** I initially wrote the integration against
`deepseek-chat`/`deepseek-reasoner`. Those are superseded; the current models are
`deepseek-v4-flash` and `deepseek-v4-pro`. Checking the live docs rather than
trusting recall caught it before the first call.

**`deepseek-v4-flash` is a reasoning model.** With `max_tokens: 200` — generous
for a three-field JSON response — three of five samples failed. The model emits
`reasoning_content` first, billed against `max_tokens`: it spent 185 tokens
reasoning and had 15 left for the answer. The symptom was empty or truncated
content, indistinguishable from a malformed response; only `finish_reason:
"length"` identified it. Budgets are now 1500 and 2000. The upside is that the
parse-failure path was exercised for real before the pipeline was built, which is
better evidence it works than a deliberate test would have been.

**`npm test` was firing ten live API calls.** Node's test runner auto-discovers
files named `test-*`, so it was executing `scripts/test-prompts.mjs` — my prompt
harness — as a test suite. Renamed to `validate-prompts.mjs` and the runner
scoped to `lib/*.test.js`.

**And one thing I got wrong myself.** I set the enrichment call to
`temperature: 0.3`, and wrote in the prompt rationale that the "copy verbatim"
instruction constrained extraction tightly enough for that to be safe. Testing
falsified it: the same message yielded `["Okta"]` on one run and `[]` on the
next. Extraction fidelity beats summary variety, so it is now `0`. The claim is
corrected in `prompts/02-enrichment.md` rather than quietly deleted.

---

## 5. Reliability, cost, latency at production scale

**Determinism is not free, and `temperature: 0` does not buy it.** Running the
same five messages twice, `category`, `priority`, `routing_destination`,
`escalation_flag` and `escalation_reasons` were identical — but `confidence` and
`identifiers` moved. Hosted LLM APIs are not deterministic at temperature 0;
batching and expert routing introduce variation regardless of sampling
parameters.

This matters because **escalation gates on `confidence < 0.70`**. On this sample
set every score landed near 0.95, far from the boundary, so escalation stayed
stable — but that is a property of these five messages, not of the design. A
genuinely ambiguous message scoring near the threshold could escalate on one run
and not the next, from identical input. Self-reported confidence is also poorly
calibrated in general; the prompt anchors each band with explicit descriptions to
reduce inflation, which narrows the problem without solving it.

**I would not ship confidence-gated escalation to production without replacing
the score with self-consistency** — sample the classification three times and use
the agreement rate. That is a measurement rather than the model's opinion of
itself, and it is stable. It triples classification cost (~$0.003 here), which is
the only reason it is not in this build.

**Cost.** `deepseek-v4-flash` over `v4-pro`: sorting into five known categories
and copying stated identifiers is not reasoning-heavy, and flash is roughly 3×
cheaper on input. Model selection should track task difficulty rather than
defaulting to the largest available. Reasoning tokens dominate spend here, so the
`max_tokens` budget is a cost lever as much as a correctness one.

**Latency.** The two calls are sequential because enrichment consumes the
classification. Merging them halves latency and cost at the expense of the
confidence isolation in §1 — a reasonable trade at high volume, and the right
place to start if p95 latency became the binding constraint.

**Other production gaps**, deliberately out of scope at this timebox:
idempotency keys so a webhook retry cannot double-write; a queue between ingest
and the LLM calls to absorb rate limits; alerting on escalation-queue depth,
since a queue nobody watches is just a slower way to drop tickets; and the
webhook is unauthenticated.

---

## 6. Phase 2

1. **Self-consistency confidence**, as above. The single highest-value change.
2. **Typed identifier extraction** — `{"invoice": "#8821"}` rather than a flat
   list, so a billing queue can key off a field instead of string-matching.
   Needs a per-category schema.
3. **Validate identifiers against the source.** Assert every extracted
   identifier appears verbatim in the raw message and escalate on failure. It is
   pure string containment, no extra model call, and it converts hallucinated
   identifiers from a silent correctness bug into a caught one. Zero
   hallucinations were observed across runs here, but the check costs nothing.
4. **Replace the security keyword match with a classifier sub-label**, removing
   the one brittle rule in the routing table.
5. **A golden set with per-category accuracy tracking.** Five samples cannot tell
   you whether a prompt change helped or hurt. Without this, every later
   improvement is guesswork.

---

## Verifying this yourself

```bash
npm test                        # 21 tests, routing and escalation logic
npm run build                   # regenerate workflow.json
bash scripts/send-samples.sh    # POST all five samples
bash scripts/merge-records.sh   # produce output.json
```

`output.json` holds the five records from the final run. `workflow.json` imports
directly into n8n.
