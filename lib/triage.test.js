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
const SAMPLE_5 = "Your dashboard stopped loading for us around 2pm EST. Checked our end — it's definitely on yours. Multiple users affected.";

test('maxCurrencyAmount picks the largest amount and strips commas', () => {
  assert.equal(maxCurrencyAmount(SAMPLE_3), 1240);
  assert.equal(maxCurrencyAmount('no money here'), 0);
  assert.equal(maxCurrencyAmount('$99.50 and $12'), 99.5);
});

test('isSecurityRelated detects identity/auth vocabulary', () => {
  assert.equal(isSecurityRelated(SAMPLE_4), true);
  assert.equal(isSecurityRelated('We want a bulk export feature'), false);
});

test('isSecurityRelated does not fire on the phrase "logging in"', () => {
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
  assert.equal(
    routeRecord({ category: 'Technical Question', raw_message: 'How do I change the chart colours?' }),
    QUEUES.PRODUCT,
  );
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
  const r = evaluateEscalation({
    category: undefined,
    confidence: undefined,
    raw_message: SAMPLE_3,
    parse_failed: true,
  });
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
