#!/usr/bin/env node
/**
 * Runs the launch video's beats against a real server and records exactly what came
 * back, with measured timings. The player replays this file; nothing in the video is
 * composed by hand. Storyboard check V-01 requires this log to be kept.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:8791';
const KEY = readFileSync('/tmp/demo.key', 'utf8').trim();
const steps = [];

const headers = (idem) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${KEY}`,
  ...(idem === undefined ? {} : { 'idempotency-key': idem }),
});

async function call(label, display, method, path, body, idem) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method, headers: headers(idem),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  const step = {
    label, command: display, status: res.status,
    decision: res.headers.get('tegata-decision'),
    latency_ms: Math.round(ms * 10) / 10,
    body: text.startsWith('{') ? JSON.parse(text) : text,
  };
  steps.push(step);
  return step;
}

const OPUS = { provider: 'anthropic', model: 'claude-opus-5' };

// --- setup, off camera -------------------------------------------------------
await call('setup', 'grant', 'POST', '/v1/subjects/user_8f21/grants',
  { credits: 1000, amount_micro_usd: 20_000_000 }, 'demo-grant-1');
await call('setup', 'grant', 'POST', '/v1/subjects/user_2c07/grants',
  { credits: 3 }, 'demo-grant-2');

// --- beat 2: the model runs, then it does not --------------------------------
const est = { ...OPUS, input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 };

await call('beat2-authorize',
  `curl -X POST $TEGATA/v1/authorizations \\
  -d '{"subject_id":"user_8f21","action":"chat.completion",
       "estimate":{"model":"claude-opus-5","input_tokens":12400,"max_output_tokens":2000}}'`,
  'POST', '/v1/authorizations',
  { subject_id: 'user_8f21', action: 'chat.completion', estimate: est }, 'demo-auth-1');

const authId = steps[steps.length - 1].body.authorization_id;

await call('beat2-capture',
  `curl -X POST $TEGATA/v1/authorizations/${String(authId).slice(0, 8)}…/capture \\
  -d '{"actual":{"input_tokens":12400,"output_tokens":1180,"cached_input_tokens":8000}}'`,
  'POST', `/v1/authorizations/${authId}/capture`,
  { actual: { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 } }, 'demo-cap-1');

await call('beat2-dishonor',
  `curl -X POST $TEGATA/v1/authorizations \\
  -d '{"subject_id":"user_2c07", ...same request...}'`,
  'POST', '/v1/authorizations',
  { subject_id: 'user_2c07', action: 'chat.completion', estimate: est }, 'demo-auth-2');

// --- beat 3: export, verify, then tamper -------------------------------------
const exportStarted = performance.now();
const exported = await (await fetch(`${BASE}/v1/register/export`, { headers: headers() })).text();
const exportMs = Math.round((performance.now() - exportStarted) * 10) / 10;
writeFileSync('/tmp/demo-register.jsonl', exported);

const verify = (file) => {
  try {
    return { ok: true, out: execFileSync('npx', ['tsx', '../packages/verify/src/cli.ts', file], { encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

steps.push({
  label: 'beat3-export',
  command: 'curl $TEGATA/v1/register/export > register.jsonl',
  status: 200, latency_ms: exportMs,
  body: `${exported.trim().split('\n').length} lines`,
});

const clean = verify('/tmp/demo-register.jsonl');
steps.push({ label: 'beat3-verify', command: 'tegata-verify register.jsonl', ok: clean.ok, output: clean.out.trim() });

const lines = exported.trim().split('\n');
const victim = JSON.parse(lines[1]);
victim.delta_amount -= 1;
lines[1] = JSON.stringify(victim);
writeFileSync('/tmp/demo-tampered.jsonl', `${lines.join('\n')}\n`);

const dirty = verify('/tmp/demo-tampered.jsonl');
steps.push({
  label: 'beat3-tamper',
  command: "# change one byte:  delta_amount 1000 -> 999\ntegata-verify register.jsonl",
  ok: dirty.ok, output: dirty.out.trim(),
});

writeFileSync('session.json', `${JSON.stringify({
  captured_at: new Date().toISOString(),
  base: BASE,
  note: 'Every response and timing below came from a running server. The player replays this file.',
  steps,
}, null, 2)}\n`);

for (const s of steps) {
  const t = s.latency_ms === undefined ? '' : ` ${s.latency_ms}ms`;
  console.log(`${s.label.padEnd(18)} ${String(s.status ?? (s.ok ? 'ok' : 'FAILED')).padEnd(7)}${t}`);
}
console.log('\nwrote demo/session.json');
