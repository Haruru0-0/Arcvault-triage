# Prompt 1 — Classification

Model: `deepseek-v4-flash` · `temperature: 0` · `max_tokens: 4000` ·
`response_format: {"type": "json_object"}`

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
matters — that a human reviews anything under 0.70 — because stating the
consequence reduces confidence inflation more than instructing "be accurate"
does.

`temperature: 0` because classification should be reproducible: the same message
must not route differently between two runs.

**`max_tokens: 4000` for a response that is three short fields.** `deepseek-v4-flash`
is a reasoning model — it emits `reasoning_content` before the answer, and those
tokens are billed against `max_tokens`. My first run set 200, and three of five
samples failed: the model spent 185 tokens reasoning and had 15 left for the
answer, so the JSON came back truncated with `finish_reason: "length"`. The
failure surfaced as empty or unparseable content, which looks like a malformed
response rather than a budget problem, and `finish_reason` was the only field
that identified it.

**I then got the size wrong a second time, which is the more useful lesson.** I
raised it to 1500 based on the 185 tokens sample 1 had used — sizing the budget
from one observation. Sample 4 ("is there a way to set up SSO with Okta?") then
consumed **1476 reasoning tokens**, roughly eight times as many, leaving 24 for
the answer and truncating the JSON at `"confidence": 0.`

Reasoning cost scales with how *ambiguous* the input is, not how long it is.
Sample 4 is the shortest kind of message and the hardest call in the set — it
sits right on the Technical Question / Feature Request boundary — so the model
deliberated far longer. A budget derived from an easy sample will hold until the
first genuinely hard one arrives, which in production means it fails on exactly
the messages that most need a correct answer.

Now 4000. `max_tokens` is a ceiling, not a reservation: unused budget costs
nothing, so there is no reason to run it tight. A silently truncated
classification, by contrast, costs a misrouted ticket.

**Tradeoffs.** The category definitions are my interpretation, not ArcVault's — a
real deployment would derive them from the receiving teams' actual intake
criteria, and getting that wrong is a far bigger source of misrouting than any
prompt wording. The prompt also has no few-shot examples; with more time I would
add two or three drawn from genuinely ambiguous historical tickets, which
typically helps boundary cases more than additional instructions do.

**Measured: confidence is not reproducible, even at `temperature: 0`.** Running
the same five messages twice, `category`, `priority` and every routing and
escalation field came back identical — but `confidence` moved. Hosted LLM APIs
do not guarantee determinism at temperature 0.

That matters more than it looks, because Step 6 gates human escalation on
`confidence < 0.70`. On this sample set every score landed near 0.95, far from
the boundary, so `escalation_flag` stayed stable — but that is a property of
these five messages, not of the design. A genuinely ambiguous message scoring
near 0.70 could escalate on one run and not the next, from identical input.

**What I would change with more time.** This turns the self-consistency idea from
a refinement into the actual fix. Sample the classification three times and use
the agreement rate as the confidence signal: agreement across runs is a real
measurement and is stable in a way a self-reported number is not. It triples
classification cost — roughly $0.003 for this run — which is why it is not here,
but I would not ship confidence-gated escalation to production without it.
