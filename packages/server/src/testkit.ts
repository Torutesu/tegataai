import { FixedClock, SeededRng, sha256Hex } from '@tegata/core';
import { Store } from '@tegata/store';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

export const TENANT = 'T0000000000000000000000000';
export const KEY = 'sk_test_tegata';

export interface Harness {
  app: FastifyInstance;
  store: Store;
  clock: FixedClock;
  post: (url: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  get: (url: string) => Promise<Response>;
  put: (url: string, body: unknown) => Promise<Response>;
  close: () => Promise<void>;
}

interface Response { status: number; body: Record<string, unknown>; text: string; headers: Record<string, unknown>; }

let keyCounter = 0;
export const nextKey = (): string => `idem-${++keyCounter}`;

export async function harness(opts: { degraded_mode?: 'allow' | 'deny'; overdraft?: number;
  tenantRps?: number; subjectRps?: number } = {}): Promise<Harness> {
  const clock = new FixedClock('2026-08-21T00:00:00.000Z');
  const rng = new SeededRng('harness');
  const store = new Store({ clock, rng });
  store.createTenant({
    tenant_id: TENANT, name: 'test', secret_key_hash: sha256Hex(KEY),
    credit_unit_micro_usd: 20_000, degraded_mode: opts.degraded_mode ?? 'allow',
    max_overdraft_credits: opts.overdraft ?? 200, cost_table_pin: null,
    webhook_url: null, webhook_secret: null, low_balance_pct: 20,
  });
  store.insertCostRates('v1', '2026-01-01T00:00:00.000Z', [
    { provider: 'anthropic', model: 'claude-opus-5', unit: 'token',
      input_micro_usd_per_unit: 15, output_micro_usd_per_unit: 75, cached_input_micro_usd_per_unit: 1 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', unit: 'token',
      input_micro_usd_per_unit: 1, output_micro_usd_per_unit: 5, cached_input_micro_usd_per_unit: 1 },
  ]);
  store.upsertAction(TENANT, {
    action: 'chat.completion', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 25, min_face_value: 1, fallback_action: 'chat.completion.mini', fallback_model: null, markup_milli: 1000,
  });
  store.upsertAction(TENANT, {
    action: 'chat.completion.mini', pricing_mode: 'token_based', fixed_credits: null,
    default_face_value: 5, min_face_value: 1, fallback_action: null,
    fallback_model: 'claude-haiku-4-5', markup_milli: 1000,
  });
  store.upsertAction(TENANT, {
    action: 'image.generate', pricing_mode: 'fixed', fixed_credits: 40,
    default_face_value: 40, min_face_value: 1, fallback_action: null, fallback_model: null, markup_milli: 1000,
  });

  // Off unless a test asks for it: a limiter would otherwise make unrelated tests
  // flaky in proportion to how many requests they happen to make.
  const app = buildApp({ store, clock, rng, tenantRps: opts.tenantRps ?? 0, subjectRps: opts.subjectRps ?? 0 });
  await app.ready();

  const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}`, ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if ((method === 'POST') && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();
    const res = await app.inject({ method: method as 'POST', url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: Record<string, unknown> = {};
    try { parsed = res.json() as Record<string, unknown>; } catch { parsed = {}; }
    return { status: res.statusCode, body: parsed, text: res.body, headers: res.headers as Record<string, unknown> };
  };

  return {
    app, store, clock,
    post: (url, body, headers) => call('POST', url, body ?? {}, headers),
    get: (url) => call('GET', url),
    put: (url, body) => call('PUT', url, body),
    close: async () => { await app.close(); store.close(); },
  };
}

export const grant = async (h: Harness, subject: string, credits: number, amountMicroUsd = 0): Promise<void> => {
  const res = await h.post(`/v1/subjects/${subject}/grants`, { credits, amount_micro_usd: amountMicroUsd });
  if (res.status !== 201) throw new Error(`grant failed: ${res.text}`);
};

export const OPUS = { provider: 'anthropic', model: 'claude-opus-5' } as const;
