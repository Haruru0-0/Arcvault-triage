/**
 * Builds workflow.json for import into n8n.
 *
 * Two things are injected rather than duplicated, so nothing can drift:
 *   - lib/triage.js       -> the "Route & Escalate" Code node
 *   - prompts/*.md        -> the system prompts in the two HTTP Request nodes
 *
 * The workflow object is constructed in JS and serialized, rather than
 * substituted into a JSON template: the prompts are multi-line text with quotes,
 * and pushing them through a text template means escaping correctly for both the
 * JS expression and the surrounding JSON. Building the object lets
 * JSON.stringify handle it.
 *
 * Usage: npm run build
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DEEPSEEK_CREDENTIAL = { id: 'uhvZCPtk6lRdNwuz', name: 'DeepSeek account' };
const MODEL = 'deepseek-v4-flash';

// Configured in Task 5 once the spreadsheet exists; blank is fine until then.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';

/** Pull the first fenced code block that follows a heading. */
function extractBlock(markdown, heading) {
  const headingAt = markdown.indexOf(heading);
  if (headingAt === -1) throw new Error(`heading not found: ${heading}`);
  const open = markdown.indexOf('```', headingAt);
  const close = markdown.indexOf('```', open + 3);
  if (open === -1 || close === -1) throw new Error(`no fenced block after: ${heading}`);
  return markdown.slice(open + 3, close).trim();
}

const CLASSIFY_SYSTEM = extractBlock(read('prompts/01-classification.md'), '## System prompt');
const ENRICH_SYSTEM = extractBlock(read('prompts/02-enrichment.md'), '## System prompt');

// Strip the trailing ESM export block; everything above it is plain script code
// that runs as-is inside an n8n Code node.
// Anchored to line start: the file's own header comment mentions "export { ... }",
// and an unanchored match would start there and strip the wrong region.
const TRIAGE_LOGIC = read('lib/triage.js')
  .replace(/^export\s*\{[\s\S]*?\};\s*$/m, '')
  .trim();

// Statement-level only — the word "export" legitimately appears in comments.
const leftoverModuleSyntax = TRIAGE_LOGIC.split('\n').filter((line) =>
  /^\s*(export[\s{]|import\s)/.test(line),
);
if (leftoverModuleSyntax.length) {
  console.error('lib/triage.js still has module syntax after stripping — the Code node would fail:');
  for (const line of leftoverModuleSyntax) console.error(`  ${line}`);
  process.exit(1);
}

/** An n8n expression producing the DeepSeek request body. */
function deepSeekBody({ system, userExpression, temperature, maxTokens }) {
  const payload = {
    model: MODEL,
    temperature,
    // deepseek-v4-flash is a reasoning model: reasoning_content is billed
    // against max_tokens, so this is far larger than the visible output needs.
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '__USER__' },
    ],
  };

  // Splice the user message in as a live expression rather than a literal.
  const json = JSON.stringify(payload).replace('"__USER__"', userExpression);
  return `={{ ${json} }}`;
}

const WEBHOOK = "$('Intake Webhook').first().json.body";

const classifyUser =
  `"Source: " + ${WEBHOOK}.source + "\\n\\nMessage:\\n" + ${WEBHOOK}.raw_message`;

const enrichUser =
  `"Category: " + $('Classify').first().json.choices[0].message.content.category + ` +
  `"\\nPriority: " + $('Classify').first().json.choices[0].message.content.priority + ` +
  `"\\nSource: " + ${WEBHOOK}.source + "\\n\\nMessage:\\n" + ${WEBHOOK}.raw_message`;

const ROUTE_CODE = `${TRIAGE_LOGIC}

// ---- n8n glue ----------------------------------------------------------
// Everything above is lib/triage.js verbatim, injected by scripts/build-workflow.mjs
// and covered by lib/triage.test.js.

const webhookBody = $('Intake Webhook').first().json.body;
const source = webhookBody.source;
const raw_message = webhookBody.raw_message;

function safeParse(nodeName) {
  try {
    const content = $(nodeName).first().json?.choices?.[0]?.message?.content;
    if (content === undefined || content === null) return null;
    if (typeof content === 'object') return content;   // n8n may pre-parse JSON responses
    if (!String(content).trim()) return null;
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

// Google Sheets cells are flat, so arrays get a joined companion field.
// The JSON file keeps the real arrays.
return [{
  json: {
    ...record,
    identifiers_text: record.identifiers.join('; '),
    escalation_reasons_text: record.escalation_reasons.join('; '),
  },
}];`;

const SHEET_COLUMNS = [
  'record_id', 'received_at', 'source', 'category', 'priority', 'confidence',
  'core_issue', 'identifiers_text', 'urgency_signal', 'routing_destination',
  'escalation_flag', 'escalation_reasons_text', 'summary', 'raw_message',
];

// Attached only if known; otherwise the node imports unconfigured and the
// credential is selected in the UI (Task 5). A placeholder id would error.
const SHEETS_CREDENTIAL_ID = process.env.GOOGLE_SHEETS_CREDENTIAL_ID || '';

function sheetsNode(name, tabName, position) {
  return {
    parameters: {
      operation: 'append',
      documentId: { __rl: true, value: SHEET_ID, mode: 'id' },
      sheetName: { __rl: true, value: tabName, mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: Object.fromEntries(SHEET_COLUMNS.map((c) => [c, `={{ $json.${c} }}`])),
        matchingColumns: [],
        schema: SHEET_COLUMNS.map((c) => ({
          id: c,
          displayName: c,
          required: false,
          defaultMatch: false,
          display: true,
          type: 'string',
          canBeUsedToMatch: true,
        })),
      },
      options: {},
    },
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    id: `sheet-${tabName.toLowerCase()}`,
    name,
    // n8n refuses to publish a workflow containing unconfigured nodes. Disabling
    // them until the sheet exists keeps the pipeline activatable and runnable
    // without Google credentials — disabled nodes pass their input straight
    // through, so the JSON file output still works.
    ...(SHEET_ID ? {} : { disabled: true }),
    ...(SHEETS_CREDENTIAL_ID
      ? {
          credentials: {
            googleSheetsOAuth2Api: { id: SHEETS_CREDENTIAL_ID, name: 'Google Sheets account' },
          },
        }
      : {}),
  };
}

const workflow = {
  name: 'ArcVault Intake & Triage',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'intake',
        responseMode: 'responseNode',
        options: {},
      },
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [-400, 0],
      id: 'intake-webhook',
      name: 'Intake Webhook',
      webhookId: 'arcvault-intake',
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'deepSeekApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: deepSeekBody({
          system: CLASSIFY_SYSTEM,
          userExpression: classifyUser,
          temperature: 0,
          maxTokens: 1500,
        }),
        options: {},
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [-180, 0],
      id: 'classify',
      name: 'Classify',
      credentials: { deepSeekApi: DEEPSEEK_CREDENTIAL },
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'deepSeekApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: deepSeekBody({
          system: ENRICH_SYSTEM,
          userExpression: enrichUser,
          temperature: 0.3,
          maxTokens: 2000,
        }),
        options: {},
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [40, 0],
      id: 'enrich',
      name: 'Enrich & Summarize',
      credentials: { deepSeekApi: DEEPSEEK_CREDENTIAL },
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: ROUTE_CODE },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [260, 0],
      id: 'route-escalate',
      name: 'Route & Escalate',
    },
    {
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: {},
      },
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [480, -180],
      id: 'respond',
      name: 'Respond',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'is-escalated',
              leftValue: '={{ $json.escalation_flag }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [480, 40],
      id: 'is-escalated',
      name: 'Is Escalated?',
    },
    sheetsNode('Sheet: Escalation', 'Escalation', [700, -60]),
    sheetsNode('Sheet: Routed', 'Routed', [700, 140]),
  ],
  connections: {
    'Intake Webhook': { main: [[{ node: 'Classify', type: 'main', index: 0 }]] },
    Classify: { main: [[{ node: 'Enrich & Summarize', type: 'main', index: 0 }]] },
    'Enrich & Summarize': { main: [[{ node: 'Route & Escalate', type: 'main', index: 0 }]] },
    'Route & Escalate': {
      main: [[
        { node: 'Respond', type: 'main', index: 0 },
        { node: 'Is Escalated?', type: 'main', index: 0 },
      ]],
    },
    'Is Escalated?': {
      main: [
        [{ node: 'Sheet: Escalation', type: 'main', index: 0 }],
        [{ node: 'Sheet: Routed', type: 'main', index: 0 }],
      ],
    },
  },
  settings: { executionOrder: 'v1' },
};

const out = JSON.stringify(workflow, null, 2);
JSON.parse(out); // fail loudly rather than shipping invalid JSON

fs.writeFileSync(path.join(ROOT, 'workflow.json'), out + '\n');

console.log(`Wrote workflow.json — ${workflow.nodes.length} nodes`);
console.log(`  classification prompt: ${CLASSIFY_SYSTEM.length} chars`);
console.log(`  enrichment prompt:     ${ENRICH_SYSTEM.length} chars`);
console.log(`  triage logic:          ${TRIAGE_LOGIC.length} chars`);
console.log(`  sheet id:              ${SHEET_ID || '(unset — configure in Task 5)'}`);
