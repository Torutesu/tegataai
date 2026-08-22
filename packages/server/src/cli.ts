#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { type JsonObject, cryptoRng, sha256Hex, systemClock, UlidFactory } from '@tegata/core';
import { verifyExport } from '@tegata/verify';
import { buildApp } from './app.js';
import { Store } from '@tegata/store';

const DB = process.env.TEGATA_DB ?? './tegata.db';

/** Rates in micro-USD per token, so the quickstart prices something real. */
const STARTER_RATES = [
  { provider: 'anthropic', model: 'claude-opus-5', unit: 'token', input_micro_usd_per_unit: 15, output_micro_usd_per_unit: 75, cached_input_micro_usd_per_unit: 1 },
  { provider: 'anthropic', model: 'claude-sonnet-5', unit: 'token', input_micro_usd_per_unit: 3, output_micro_usd_per_unit: 15, cached_input_micro_usd_per_unit: 1 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', unit: 'token', input_micro_usd_per_unit: 1, output_micro_usd_per_unit: 5, cached_input_micro_usd_per_unit: 1 },
  { provider: 'openai', model: 'gpt-5', unit: 'token', input_micro_usd_per_unit: 10, output_micro_usd_per_unit: 30, cached_input_micro_usd_per_unit: 1 },
];

function bootstrap(): void {
  const store = new Store({ path: DB, clock: systemClock, rng: cryptoRng });
  const ulid = new UlidFactory(() => cryptoRng.next());
  const tenantId = ulid.generate(systemClock.now());
  const secret = `sk_live_${randomBytes(24).toString('base64url')}`;
  const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;

  store.createTenant({
    tenant_id: tenantId, name: process.argv[3] ?? 'default',
    secret_key_hash: sha256Hex(secret), credit_unit_micro_usd: 20_000,
    degraded_mode: 'allow', max_overdraft_credits: 200, cost_table_pin: null,
    webhook_url: null, webhook_secret: webhookSecret, low_balance_pct: 20,
  });
  store.insertCostRates('v1', new Date(systemClock.now()).toISOString(), STARTER_RATES);
  store.upsertAction(tenantId, {
    action: 'chat.completion', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 25, min_face_value: 1, fallback_action: 'chat.completion.mini',
    fallback_model: null, markup_milli: 1000,
  });
  store.upsertAction(tenantId, {
    // The cheaper lane names the model it would use, so the remedy is priced honestly.
    action: 'chat.completion.mini', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 5, min_face_value: 1, fallback_action: null,
    fallback_model: 'claude-haiku-4-5', markup_milli: 1000,
  });
  store.upsertAction(tenantId, {
    action: 'image.generate', pricing_mode: 'fixed', fixed_credits: 40,
    default_face_value: 40, min_face_value: 1, fallback_action: null, fallback_model: null, markup_milli: 1000,
  });
  store.close();

  process.stdout.write([
    `database        ${DB}`,
    `tenant          ${tenantId}`,
    `secret key      ${secret}`,
    `webhook secret  ${webhookSecret}`,
    '',
    'The secret key is not stored and cannot be shown again — only its hash is kept.',
    '',
    `  export TEGATA_KEY=${secret}`,
    '  pnpm dev',
    '',
  ].join('\n'));
}

/**
 * `bootstrap` creates a tenant and prints a key; running the thing then takes a second
 * shell, a copied secret and a hand-written request body. That is the cost of finding
 * out whether this is worth anything — and it is what competes with writing a credit
 * ledger yourself, which the people with the sharpest version of this problem have
 * already done.
 *
 * So `try` does the whole lifecycle in one command, in one shell, against a database it
 * throws away: fund a subject, authorize before the model runs, settle with what was
 * actually used, read the balance back, and verify the register without trusting the
 * server that produced it. Every number it prints comes from that run.
 */
async function attempt(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tegata-try-'));
  const store = new Store({ path: join(dir, 'try.db'), clock: systemClock, rng: cryptoRng });
  const ulid = new UlidFactory(() => cryptoRng.next());
  const tenantId = ulid.generate(systemClock.now());
  const secret = `sk_live_${randomBytes(24).toString('base64url')}`;

  store.createTenant({
    tenant_id: tenantId, name: 'try', secret_key_hash: sha256Hex(secret),
    credit_unit_micro_usd: 20_000, degraded_mode: 'allow', max_overdraft_credits: 200,
    cost_table_pin: null, webhook_url: null, webhook_secret: null, low_balance_pct: 20,
  });
  store.insertCostRates('v1', new Date(systemClock.now()).toISOString(), STARTER_RATES);
  store.upsertAction(tenantId, {
    action: 'chat.completion', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 25, min_face_value: 1, fallback_action: 'chat.completion.mini',
    fallback_model: null, markup_milli: 1000,
  });
  store.upsertAction(tenantId, {
    action: 'chat.completion.mini', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 5, min_face_value: 1, fallback_action: null,
    fallback_model: 'claude-haiku-4-5', markup_milli: 1000,
  });

  const app = buildApp({ store, clock: systemClock, tenantRps: 0, subjectRps: 0 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const started = systemClock.now();
  let step = 0;
  const call = async (method: string, path: string, body?: unknown): Promise<JsonObject> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'idempotency-key': `try-${(step += 1)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
    return JSON.parse(text) as JsonObject;
  };

  const say = (line: string): void => { process.stdout.write(`${line}\n`); };
  /** Micro-USD is the unit; dollars are what a person reads. */
  const micro = (v: number): string => `$${(v / 1_000_000).toFixed(4)}`;

  say('');
  say('  A user with credits, an action priced from real rates, and one call before it runs.');
  say('');

  const granted = await call('POST', '/v1/subjects/u_1/grants', { credits: 1000 });
  say(`  fund      u_1 now holds ${String(granted.balance ?? 1000)} credits`);

  const auth = await call('POST', '/v1/authorizations', {
    subject_id: 'u_1',
    action: 'chat.completion',
    estimate: {
      provider: 'anthropic', model: 'claude-opus-5',
      input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000,
    },
  });
  say(`  issue     ${String(auth.decision)} — face value ${String(auth.face_value)}, `
    + `${String(auth.available_after_hold)} left to spend`);
  say('            (the hold moves no balance; only settling does)');

  const settled = await call('POST', `/v1/authorizations/${String(auth.authorization_id)}/capture`, {
    actual: { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 },
  });
  say(`  capture   charged ${String(settled.captured_amount)} of the ${String(auth.face_value)} held `
    + `— the model used less than the estimate, so the rest went back`);

  const subject = await call('GET', '/v1/subjects/u_1');
  say(`  balance   ${String(subject.balance)} credits, ${String(subject.reserved)} reserved, `
    + `${String(subject.available)} available`);

  /**
   * The number the whole product is about, on one call. Not the margin report — that
   * recognises subscription revenue across the period it covers, so in a run this short
   * it is correctly zero and would read as a loss.
   */
  const charged = Number(settled.captured_amount) * 20_000;   // credit_unit_micro_usd
  const margin = await call('GET', '/v1/metrics/margin');
  const spent = Number((margin.summary as JsonObject).cost_micro_usd);
  say(`  margin    this call: charged ${micro(charged)}, the model cost ${micro(spent)}, `
    + `kept ${micro(charged - spent)}`);

  // The point of the register is that it does not need us to be honest about it.
  const exported = await fetch(`${base}/v1/register/export`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const report = verifyExport(await exported.text());
  say(`  verify    ${String(report.entries)} entries, hash chain ${report.ok ? 'intact' : 'BROKEN'} `
    + '— checked here, not taken on trust');

  say('');
  say(`  ${String(systemClock.now() - started)}ms, start to verified ledger.`);
  say('');
  say('  Do it yourself against a server you keep:');
  say('');
  say('    pnpm bootstrap && pnpm dev');
  say('');
  say(`  This run used a database in ${dir} and is about to delete it.`);
  say('');

  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

const command = process.argv[2];
if (command === 'bootstrap') bootstrap();
else if (command === 'try') await attempt();
else {
  process.stderr.write('usage: tegata bootstrap [tenant-name]\n       tegata try\n');
  process.exit(1);
}
