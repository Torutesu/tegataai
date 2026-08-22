import { describe, expect, it } from 'vitest';
import { FixedClock, SeededRng, sha256Hex } from '@tegata/core';
import { Store } from '@tegata/store';
import { buildApp } from '@tegata/server';
import type { FastifyInstance } from 'fastify';
import { TegataClient, normaliseUsage } from './index.js';

const TENANT = 'T0000000000000000000000000';
const KEY = 'sk_test';

interface Rig {
  client: TegataClient;
  store: Store;
  app: FastifyInstance;
  /** Flip to simulate the enforcement service being unreachable. */
  setReachable: (v: boolean) => void;
  close: () => Promise<void>;
}

async function rig(opts: { degraded?: 'allow' | 'deny'; timeoutMs?: number } = {}): Promise<Rig> {
  const clock = new FixedClock('2026-08-21T00:00:00.000Z');
  const store = new Store({ clock, rng: new SeededRng('sdk') });
  store.createTenant({
    tenant_id: TENANT, name: 't', secret_key_hash: sha256Hex(KEY), credit_unit_micro_usd: 20_000,
    degraded_mode: opts.degraded ?? 'allow', max_overdraft_credits: 200, cost_table_pin: null,
    webhook_url: null, webhook_secret: null, low_balance_pct: 20,
  });
  store.upsertAction(TENANT, {
    action: 'chat.completion', pricing_mode: 'fixed', fixed_credits: 10,
    default_face_value: 10, min_face_value: 1, fallback_action: null, fallback_model: null, markup_milli: 1000,
  });
  const app = buildApp({ store, clock });
  await app.ready();

  let reachable = true;
  // A fetch that routes into the in-process server, or refuses like a dead socket.
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (!reachable) throw new Error('ECONNREFUSED');
    const u = new URL(String(url));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'POST',
      url: u.pathname + u.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string,
    });
    return {
      status: res.statusCode,
      json: async () => res.json() as unknown,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  const client = new TegataClient({
    baseUrl: 'http://tegata.test', secretKey: KEY,
    timeoutMs: opts.timeoutMs ?? 200, fetch: fetchImpl, maxOverdraftCredits: 200,
    ...(opts.degraded === undefined ? {} : { degraded: opts.degraded }),
  });
  return { client, store, app, setReachable: (v) => { reachable = v; }, close: async () => { await app.close(); store.close(); } };
}

const seed = (store: Store, subject: string, credits: number): void => {
  store.ensureSubject(TENANT, subject);
  store.grant(TENANT, subject, { source: 'grant', credits });
};

describe('usage mapping', () => {
  it('reads the Anthropic shape, folding cache reads into the input total', () => {
    expect(normaliseUsage({ input_tokens: 4_400, output_tokens: 1_180, cache_read_input_tokens: 8_000 }))
      .toEqual({ input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 });
  });

  it('reads the OpenAI shape, including nested cached tokens', () => {
    expect(normaliseUsage({ prompt_tokens: 12_400, completion_tokens: 1_180, prompt_tokens_details: { cached_tokens: 8_000 } }))
      .toEqual({ input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 });
  });

  it('ignores fields it does not understand rather than passing them on', () => {
    expect(normaliseUsage({ input_tokens: 5, total_tokens: 99, model: 'x' }))
      .toEqual({ input_tokens: 5 });
  });
});

describe('the happy path', () => {
  it('issues, settles, and leaves the ledger balanced', async () => {
    const r = await rig();
    seed(r.store, 'u1', 100);
    const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    const d = await guard.issue();
    expect(d.dishonored).toBe(false);
    if (!d.dishonored) expect(d.face_value).toBe(10);

    await guard.capture({ input_tokens: 100, output_tokens: 50 }, { amount: 7 });
    expect(r.store.balances(TENANT, 'u1')).toEqual({ balance: 93, reserved: 0, available: 93 });
    await r.close();
  });

  it('returns a refusal as a decision rather than throwing', async () => {
    const r = await rig();
    seed(r.store, 'u1', 1);
    const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    const d = await guard.issue();
    expect(d.dishonored).toBe(true);
    if (d.dishonored) expect(d.reason).toBe('insufficient_balance');
    await r.close();
  });

  it('releases the hold when the caller fails', async () => {
    const r = await rig();
    seed(r.store, 'u1', 100);
    const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    await guard.issue();
    expect(r.store.balances(TENANT, 'u1').reserved).toBe(10);
    await guard.release('provider_error');
    expect(r.store.balances(TENANT, 'u1')).toEqual({ balance: 100, reserved: 0, available: 100 });
    await r.close();
  });

  it('raises a 4xx to the caller instead of hiding it', async () => {
    const r = await rig();
    const guard = r.client.guard({ subjectId: 'u1', action: 'never.registered' });
    await expect(guard.issue()).rejects.toThrow(/not found/i);
    await r.close();
  });
});

describe('the enforcement service is unreachable (AC-02)', () => {
  it('keeps the application running under the allow posture', async () => {
    const r = await rig({ degraded: 'allow' });
    seed(r.store, 'u1', 100);

    // One good call so the client knows the balance, as it would in production.
    const warm = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    await warm.issue();
    await warm.release();

    r.setReachable(false);

    let ran = 0;
    for (let i = 0; i < 5; i++) {
      const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
      const d = await guard.issue();
      expect(d.dishonored).toBe(false);          // the product keeps working
      if (!d.dishonored) expect(d.provisional).toBe(true);
      ran++;
      await guard.capture(undefined, { amount: 7 });
    }
    expect(ran).toBe(5);
    expect(r.client.pendingCaptures).toBe(5);    // nothing was lost, only deferred
    await r.close();
  });

  it('refuses under the deny posture, and says why', async () => {
    const r = await rig({ degraded: 'deny' });
    seed(r.store, 'u1', 100);
    r.setReachable(false);
    const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    const d = await guard.issue();
    expect(d.dishonored).toBe(true);
    if (d.dishonored) expect(d.reason).toBe('service_degraded');
    await r.close();
  });

  it('does not wait longer than its timeout', async () => {
    const slow = (async () => new Promise(() => { /* never settles */ })) as unknown as typeof globalThis.fetch;
    const client = new TegataClient({
      baseUrl: 'http://x', secretKey: 'k', timeoutMs: 50, fetch: slow, degraded: 'allow',
    });
    const started = Date.now();
    const d = await client.guard({ subjectId: 'u1', action: 'a' }).issue();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d.dishonored).toBe(false);
  });
});

describe('reconciliation after recovery (AC-03)', () => {
  it('replays queued settlements exactly once and lands on the right balance', async () => {
    const r = await rig({ degraded: 'allow' });
    seed(r.store, 'u1', 100);
    const warm = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    await warm.issue();
    await warm.release();

    r.setReachable(false);
    for (let i = 0; i < 4; i++) {
      const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
      await guard.issue();
      await guard.capture(undefined, { amount: 7 });
    }
    expect(r.store.balances(TENANT, 'u1').balance).toBe(100);   // nothing recorded yet

    r.setReachable(true);
    const first = await r.client.flush();
    expect(first).toEqual({ sent: 4, remaining: 0 });
    expect(r.store.balances(TENANT, 'u1')).toEqual({ balance: 72, reserved: 0, available: 72 });

    // A second flush must not double-charge: the keys are the same.
    await r.client.flush();
    expect(r.store.balances(TENANT, 'u1').balance).toBe(72);

    // And the register still agrees with itself.
    expect(r.store.verifySubjectChain(TENANT, 'u1')).toEqual({ ok: true });
    expect(r.store.rebuildProjection(TENANT, 'u1')).toEqual(r.store.balances(TENANT, 'u1'));
    await r.close();
  });

  it('keeps items queued when the service is still down, and drains later', async () => {
    const r = await rig({ degraded: 'allow' });
    seed(r.store, 'u1', 100);
    const warm = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    await warm.issue();
    await warm.release();

    r.setReachable(false);
    const guard = r.client.guard({ subjectId: 'u1', action: 'chat.completion' });
    await guard.issue();
    await guard.capture(undefined, { amount: 5 });

    expect(await r.client.flush()).toEqual({ sent: 0, remaining: 1 });
    r.setReachable(true);
    expect(await r.client.flush()).toEqual({ sent: 1, remaining: 0 });
    expect(r.store.balances(TENANT, 'u1').balance).toBe(95);
    await r.close();
  });
});
