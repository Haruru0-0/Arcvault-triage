# ArcVault Intake & Triage Pipeline — Design

**Assessment:** Valsoft AI Engineer Technical Assessment
**Date:** 2026-08-06
**Status:** Approved, pending implementation

---

## 1. Goal

Process unstructured inbound customer requests end-to-end: ingest → classify →
enrich → route → persist → escalate. Five synthetic sample messages are the test
set. Built on n8n (self-hosted, Docker) with DeepSeek as the LLM and Google
Sheets as the output destination.

Design priority, per the assessment's own guidance: **clarity and defensible
reasoning over feature count.** Every component below earns its place.

---

## 2. Architecture

Linear pipeline, one execution per inbound message.

```
POST /webhook/intake
        │
        ▼
  [1] Normalize Input          (Code)   — record_id, received_at, validation
        │
        ▼
  [2] Classify                 (HTTP)   — DeepSeek call #1
        │
        ▼
  [3] Parse Classification     (Code)   — JSON parse, failure → dead-letter
        │
        ▼
  [4] Enrich & Summarize       (HTTP)   — DeepSeek call #2
        │
        ▼
  [5] Parse Enrichment         (Code)   — JSON parse, failure → dead-letter
        │
        ▼
  [6] Route & Escalate         (Code)   — deterministic, no LLM
        │
        ▼
  [7] IF escalation_flag
        ├── true  ──▶ Sheets: "Escalation" tab ──┐
        └── false ──▶ Sheets: "Routed" tab ──────┤
                                                  ▼
                                    [8] Write /data/records/<id>.json
```

**Where state lives:** nowhere persistent inside n8n. Each execution is
stateless and self-contained; the Google Sheet and the per-record JSON files are
the only durable state. This is deliberate — it makes every message independently
replayable, which matters more than any efficiency gained by batching.

### Why two LLM calls instead of one

Classification and enrichment are separated so the model self-assesses
confidence on the classification task *alone*, uncontaminated by the harder
extraction/summarization work. It also produces two cleanly documentable prompts
for deliverable 4.3.

The tradeoff: enrichment receives the classification as input, so a
misclassification propagates downstream. Accepted — the alternative (fully
independent calls) loses the enrichment step's ability to tailor extraction to
the category. At 2 calls × 5 messages, cost and latency are irrelevant here;
at production volume this is the first thing to revisit.

---

## 3. Record schema

Single contract, written identically to both Sheets tabs and the JSON file.

```json
{
  "record_id": "av-20260806T142231Z-a3f9",
  "received_at": "2026-08-06T14:22:31Z",
  "source": "Email",
  "raw_message": "...",
  "category": "Bug Report",
  "priority": "High",
  "confidence": 0.92,
  "core_issue": "User receives 403 on login following last Tuesday's update.",
  "identifiers": ["arcvault.io/user/jsmith", "403"],
  "urgency_signal": "Single user blocked from access; began after a known release.",
  "routing_destination": "Engineering",
  "escalation_flag": false,
  "escalation_reasons": [],
  "summary": "..."
}
```

`identifiers` and `escalation_reasons` are arrays in JSON; joined with `"; "`
when written to a Sheets cell.

`escalation_reasons` is empty when not escalated, otherwise contains one or more
of: `low_confidence`, `incident_category`, `outage_keyword`,
`billing_threshold`, `unknown_category`, `llm_parse_failure`.

It is an **array rather than a single value** because a record can genuinely
escalate for two reasons at once (a low-confidence billing dispute over $500),
and a human triager benefits from seeing both. A single field would force an
arbitrary precedence order and silently discard information. Naming *why*
something escalated is what makes the escalation queue actionable rather than
just a pile.

---

## 4. LLM configuration

- **Provider:** DeepSeek (OpenAI-compatible), `POST https://api.deepseek.com/chat/completions`
- **Model:** `deepseek-v4-flash`
- **JSON mode:** `response_format: {"type": "json_object"}`
- **Temperature:** `0` for classification (reproducibility matters for a demo
  and for calibration), `0.3` for enrichment/summary (prose quality).
- **`max_tokens`:** `1500` classification, `2000` enrichment. See the
  reasoning-model note below — these are far larger than the visible output
  needs, deliberately.
- **Credentials:** entered into n8n's credential manager in the browser. Never
  committed to the repo.

**Model choice:** `deepseek-v4-flash` over `deepseek-v4-pro` — classification
into five known categories and extraction of stated identifiers are not
reasoning-heavy tasks, and flash is ~3× cheaper on input and pro's advantage
would not show. At $0.14/1M input and $0.28/1M output, the full five-message
demo run costs a fraction of a cent. Worth stating in the write-up: model
selection should follow task difficulty, not default to the largest available.

**JSON mode requirements** (both prompts comply): DeepSeek requires the literal
word "json" to appear in the system or user prompt, *and* that the prompt include
an example of the target structure. Both prompts embed a schema example, which is
good prompt design regardless.

**Vendor-documented failure mode:** DeepSeek notes that JSON mode "may
occasionally return empty content." This is not hypothetical defensive coding —
it is a known behaviour of the chosen provider, and it is precisely what the
parse-failure path in §7 exists to absorb.

**Reasoning-model token budget (measured, not assumed).** `deepseek-v4-flash`
generates `reasoning_content` before its answer, and those tokens count against
`max_tokens`. With `max_tokens: 200`, three of the five samples failed: the model
used 185 tokens reasoning and had 15 left, returning truncated JSON with
`finish_reason: "length"`.

Two things make this worth recording. First, it presents as empty or malformed
content — indistinguishable from the vendor-documented quirk above — and only
`finish_reason` distinguishes a budget problem from a bad response. Second, it
means the parse-failure path was exercised for real before the pipeline was even
built, which is stronger evidence that it works than any deliberate test would
have been. Budgets are now 1500 and 2000 against observed reasoning use of
200–800 tokens.

### Confidence calibration — known weakness

LLM self-reported confidence is poorly calibrated; models cluster near 0.9
regardless of correctness. Step 6 gates escalation on `confidence < 0.70`, so
this number carries real weight.

Mitigation: the classification prompt **anchors the scale** with explicit
descriptions of what each band means (0.9+ = message states its intent
unambiguously; 0.7–0.9 = clear category, some ambiguity in detail; 0.5–0.7 =
plausibly two categories; <0.5 = insufficient information) rather than asking for
a bare number.

This narrows the problem but does not solve it. Proper fixes — token logprobs,
or self-consistency sampling across N runs with agreement rate as the confidence
signal — are out of scope at this timebox and are documented as such in the
write-up. Stating this honestly is preferable to implying the score is
trustworthy.

---

## 5. Routing logic

Deterministic, in a Code node. No LLM involvement — routing must be auditable and
reproducible.

| Category | Destination |
|---|---|
| Bug Report | Engineering |
| Incident/Outage | Engineering |
| Feature Request | Product |
| Billing Issue | Billing |
| Technical Question | IT/Security *if* security-related, else Product |
| *unmapped / parse failure* | General Triage (fallback) |

**Incident/Outage → Engineering, not IT/Security:** an outage of ArcVault's own
dashboard is an engineering/SRE concern. IT/Security owns access, identity, and
authentication.

**The Technical Question conditional:** a keyword test on the raw message for
auth/identity terms (`sso`, `okta`, `saml`, `oauth`, `mfa`, `2fa`, `auth
provider`, `permissions`, `access control`). Scoped to the Technical Question
category only, so a Bug Report mentioning "login" is unaffected.

This exists because it's correct on the assessment's own sample #4 (Okta/SSO
evaluation), which pure category→queue mapping sends to Product. It is one rule,
transparent and inspectable.

Tradeoff: keyword matching is brittle to phrasing. At scale the right answer is a
sub-label on the classifier rather than a string match — noted in the write-up.

**Fallback:** any category outside the five defined values, or any record that
failed parsing, routes to **General Triage** and is escalated. The pipeline never
silently drops a message.

---

## 6. Escalation logic

`escalation_flag = true` if **any** of:

1. `confidence < 0.70` → `low_confidence` *(per assessment spec)*
2. `category == "Incident/Outage"` → `incident_category`
3. Regex match on outage language → `outage_keyword`
   `/outage|down for all users|all users (are )?(down|affected)|multiple users (are )?(affected|impacted)|service is down|widespread/i`
4. `category == "Billing Issue"` **and** max currency amount in message > $500 → `billing_threshold`
5. `category` is not one of the five defined values → `unknown_category`
6. LLM call or JSON parse failed after one retry → `llm_parse_failure`
   *(short-circuits — when parsing failed the other signals cannot be trusted,
   so this is the sole reason recorded)*

### Why category is the primary incident signal, not keywords

Sample #5 reads *"Your dashboard stopped loading for us around 2pm EST... Multiple
users affected."* It contains neither the word "outage" nor the phrase "down for
all users." A keyword-only rule — the obvious reading of the assessment's
wording — **misses the most clearly escalation-worthy message in the set.**

So classification is the primary signal and keywords are a secondary net for
cases the classifier underrates. Rule 3 is defence in depth, not the mechanism.

### Documented assumption: the $500 billing threshold

"billing error > $500" is ambiguous. In sample #3 the disputed **delta** is $260
($1,240 charged vs $980 contracted), while the **amount in question** is $1,240.

Interpretation taken: **the maximum currency amount mentioned in the message.**
Rationale — under-escalating a billing dispute is more costly than
over-escalating one, and the delta is often not extractable when a customer
states only one figure. Sample #3 therefore escalates. This assumption is stated
explicitly in the write-up rather than buried.

---

## 7. Error handling

The assessment weights edge-case handling at 20%. Three failure modes:

1. **API failure** (timeout, rate limit, 5xx) — n8n node retry: 1 retry, 2s wait.
2. **Malformed or empty JSON** — parse inside `try/catch` in the Code node. The
   empty-content case is explicitly checked, not just caught, since DeepSeek
   documents it as a known JSON-mode behaviour (§4).
3. **Unrecoverable** — record is written with `escalation_flag: true`,
   `escalation_reasons: ["llm_parse_failure"]`, `routing_destination: "General
   Triage"`, and whatever fields were successfully obtained.

**The escalation queue doubles as the dead-letter queue.** A failed record lands
in front of a human with its raw message intact, which is exactly the correct
outcome — the same place an ambiguous record goes. No separate machinery.

---

## 8. Ingestion

n8n Webhook node, `POST /webhook/intake`, body `{ source, raw_message }`.

The five samples are sent as **five separate POST requests** via a shell script,
so the demo shows genuine event-driven triggering rather than pre-loaded data.
This satisfies "the workflow starts automatically when a new message arrives"
literally.

---

## 9. Output destinations

**Primary — Google Sheets**, one spreadsheet, two tabs:
- `Routed` — `escalation_flag == false`
- `Escalation` — `escalation_flag == true`

Identical column schema on both. Auth via **service account**: create it in Google
Cloud, then share the spreadsheet with the service account's email address. This
avoids OAuth redirect-URI configuration against self-hosted n8n, which is the
single largest time risk in this build.

**Secondary — per-record JSON** at `/data/records/<record_id>.json` (Docker
volume → `./data/records`). Merged into a single `output.json` array with one
shell command for deliverable 4.2.

The second destination is insurance: if Sheets auth stalls, the required JSON
deliverable still exists. One extra node.

### Expected demo result

| # | Category | Destination | Escalated |
|---|---|---|---|
| 1 | Bug Report | Engineering | No |
| 2 | Feature Request | Product | No |
| 3 | Billing Issue | Billing | **Yes** — `billing_threshold` |
| 4 | Technical Question | IT/Security | No |
| 5 | Incident/Outage | Engineering | **Yes** — `incident_category` |

Both branches populate and all four primary queues are exercised — the sample set
demonstrates the full routing surface.

---

## 10. Deliverables mapping

| Req | Deliverable | Artifact |
|---|---|---|
| 4.1 | Working workflow | `workflow.json` export + step screenshots (+ optional Loom) |
| 4.2 | Structured output | `output.json` + shared Google Sheet link |
| 4.3 | Prompt documentation | `prompts/` — both prompts with per-prompt rationale |
| 4.4 | Architecture write-up | `WRITEUP.md`, 1–2 pages, derived from this spec |

Section 6 submission (email to recruiting contact, subject `AI Engineer
Assessment — [Your Name]`) is the candidate's to send.

---

## 11. Explicitly out of scope

Deliberately excluded — the assessment penalizes overbuilding and timeboxes at
3–5 hours:

- Vector store / RAG over historical tickets
- Multi-agent or tool-calling architectures
- Automated evaluation harness or golden-set scoring
- Auth, rate limiting, or multi-tenancy on the webhook
- Real email ingestion (Gmail/Mailhog) — webhook demonstrates the same property
- Retry/backoff beyond a single retry

Several of these belong in the write-up's "Phase 2" and "production scale"
sections, where describing them costs nothing and demonstrates the same thinking.
