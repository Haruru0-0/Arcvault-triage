/**
 * Exercises both prompts against DeepSeek directly, outside n8n.
 *
 * Iterating on a prompt through the n8n canvas is slow; this runs the same two
 * calls and the same buildRecord() the workflow uses, so a prompt can be proven
 * before it is wired into nodes.
 *
 * Usage:
 *   set -a && source .env && set +a && node scripts/test-prompts.mjs > /tmp/check.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecord } from '../lib/triage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set.');
  console.error('Copy .env.example to .env, fill in the key, then run:');
  console.error('  set -a && source .env && set +a && node scripts/test-prompts.mjs');
  process.exit(1);
}

/** Pull the first fenced code block that follows a given heading. */
function extractBlock(markdown, heading) {
  const headingAt = markdown.indexOf(heading);
  if (headingAt === -1) throw new Error(`heading not found: ${heading}`);
  const open = markdown.indexOf('```', headingAt);
  const close = markdown.indexOf('```', open + 3);
  if (open === -1 || close === -1) throw new Error(`no fenced block after: ${heading}`);
  return markdown.slice(open + 3, close).trim();
}

const classifyMd = fs.readFileSync(path.join(ROOT, 'prompts/01-classification.md'), 'utf8');
const enrichMd = fs.readFileSync(path.join(ROOT, 'prompts/02-enrichment.md'), 'utf8');

const CLASSIFY_SYSTEM = extractBlock(classifyMd, '## System prompt');
const ENRICH_SYSTEM = extractBlock(enrichMd, '## System prompt');

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
    throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  // DeepSeek documents that JSON mode can occasionally return empty content.
  if (!content || !content.trim()) {
    throw new Error('DeepSeek returned empty content');
  }
  return JSON.parse(content);
}

const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/inbound.json'), 'utf8'));
const records = [];

for (const sample of samples) {
  process.stderr.write(`Processing sample ${sample.id}... `);

  let classification = {};
  let enrichment = {};
  let parse_failed = false;

  try {
    classification = await callDeepSeek({
      system: CLASSIFY_SYSTEM,
      user: `Source: ${sample.source}\n\nMessage:\n${sample.raw_message}`,
      temperature: 0,
      maxTokens: 200,
    });

    enrichment = await callDeepSeek({
      system: ENRICH_SYSTEM,
      user:
        `Category: ${classification.category}\n` +
        `Priority: ${classification.priority}\n` +
        `Source: ${sample.source}\n\n` +
        `Message:\n${sample.raw_message}`,
      temperature: 0.3,
      maxTokens: 600,
    });

    process.stderr.write('ok\n');
  } catch (err) {
    process.stderr.write(`FAILED: ${err.message}\n`);
    parse_failed = true;
  }

  records.push(
    buildRecord({
      source: sample.source,
      raw_message: sample.raw_message,
      classification,
      enrichment,
      parse_failed,
    }),
  );
}

console.log(JSON.stringify(records, null, 2));

console.error('\n--- Summary ---');
for (const r of records) {
  const escalated = r.escalation_flag ? `ESCALATED (${r.escalation_reasons.join(', ')})` : '';
  console.error(
    `${String(r.category).padEnd(19)} ${String(r.priority).padEnd(7)} ` +
      `conf=${String(r.confidence).padEnd(5)} -> ${String(r.routing_destination).padEnd(14)} ${escalated}`,
  );
}
