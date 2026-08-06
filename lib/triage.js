/**
 * Routing and escalation logic for the ArcVault intake pipeline.
 *
 * This is the single source of truth for these rules. `scripts/build-workflow.mjs`
 * strips the trailing `export { ... }` block and injects everything above it into
 * the n8n "Route & Escalate" Code node, so the rules that run in production are
 * literally the rules covered by `lib/triage.test.js`.
 *
 * Constraint that follows from that: no top-level `import`, and no `export`
 * keyword on any declaration. Only the export block at the bottom.
 */

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
  // An outage of ArcVault's own service is an engineering/SRE concern.
  // IT/Security owns access, identity and authentication.
  'Incident/Outage': QUEUES.ENGINEERING,
  'Feature Request': QUEUES.PRODUCT,
  'Billing Issue': QUEUES.BILLING,
  // 'Technical Question' is handled conditionally in routeRecord().
};

const CONFIDENCE_THRESHOLD = 0.7;
const BILLING_THRESHOLD = 500;

// Applied only to Technical Questions, so "logging in" in a bug report is unaffected.
const SECURITY_TERMS =
  /\b(sso|okta|saml|oauth|mfa|2fa|idp|ldap|scim|auth provider|authentication provider|identity provider|access control|permissions?)\b/i;

// Secondary net only. Category is the primary incident signal — sample 5 escalates
// on category precisely because it contains none of these phrases.
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
