# Prompt 2 — Enrichment and summary

Model: `deepseek-v4-flash` · `temperature: 0.3` · `max_tokens: 2000` ·
`response_format: {"type": "json_object"}`

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
the confidence-calibration reason given in prompt 1. That is where I drew the
line between separating concerns and over-engineering.

The classification result is passed in as context so extraction can be
category-aware: a Billing Issue should surface invoice numbers and amounts, while
a Bug Report should surface error codes. The cost of this is coupling — a
misclassification propagates into the enrichment, and the enriched record then
looks confidently wrong rather than obviously wrong. I accepted that because the
grounding benefit is larger at this scale, but it is the first thing I would
measure in production.

"Never invent an identifier" appears twice, once as a field rule and once as a
general constraint, because hallucinated identifiers are the highest-cost failure
mode here: a fabricated invoice number sends a billing agent chasing a record
that does not exist, and the error is not visible until someone has wasted time
on it. Repeating the constraint that matters most is deliberate.

`temperature: 0.3` rather than `0`, because the summary is prose and fully greedy
decoding tends toward stilted, repetitive sentences. Extraction is constrained
enough by the "copy verbatim" instruction that a small temperature does not put
identifier fidelity at risk.

`max_tokens: 2000` — higher than prompt 1 because this call emits four fields
including a multi-sentence summary, on top of the reasoning tokens
`deepseek-v4-flash` generates before answering. See prompt 1's rationale for why
that budget matters more than it looks.

Verified against all five samples: every extracted identifier appears verbatim in
its source message, and no field was fabricated. That is the check that matters
most for this prompt, so it is worth stating as a result rather than an
intention.

**Tradeoffs.** `identifiers` is a flat array of strings rather than typed
key/value pairs. Typed extraction (`{"invoice": "#8821"}`) would be more useful
downstream — a billing queue could key off `invoice` directly instead of
string-matching a list — but it needs a per-category schema, and at five sample
messages a flat list is honest about what is actually known. I would type it
before this went near a real queue.

**What I would change with more time.** Add a validation pass asserting that
every returned identifier appears as a substring of the raw message, and route
any record that fails to the escalation queue. That converts hallucinated
identifiers from a silent correctness bug into a caught, visible one, and it is
cheap — string containment, no extra model call.
