#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { SeededRng, sha256Hex, systemClock, UlidFactory } from '@tegata/core';
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
  const rng = new SeededRng(randomBytes(4).readUInt32BE(0));
  const store = new Store({ path: DB, clock: systemClock, rng });
  const ulid = new UlidFactory(() => rng.next());
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

const command = process.argv[2];
if (command === 'bootstrap') bootstrap();
else {
  process.stderr.write('usage: tegata bootstrap [tenant-name]\n');
  process.exit(1);
}
