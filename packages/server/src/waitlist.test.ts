import { describe, expect, it } from 'vitest';
import { FixedClock, SeededRng, sha256Hex } from '@tegata/core';
import { Store } from '@tegata/store';
import { buildApp } from './app.js';
import { KEY, TENANT } from './testkit.js';

/**
 * A public, unauthenticated form on a page a stranger's browser loads. Most of what
 * follows is about what it refuses to tell that stranger.
 */
const rig = async (opts: { origins?: string[]; rpm?: number } = {}) => {
  const clock = new FixedClock('2026-08-21T00:00:00.000Z');
  const store = new Store({ clock, rng: new SeededRng('wl') });
  store.createTenant({
    tenant_id: TENANT, name: 't', secret_key_hash: sha256Hex(KEY), credit_unit_micro_usd: 20_000,
    degraded_mode: 'allow', max_overdraft_credits: 0, cost_table_pin: null,
    webhook_url: null, webhook_secret: null, low_balance_pct: 20,
  });
  const app = buildApp({
    store, clock, rng: new SeededRng('wl'), tenantRps: 0, subjectRps: 0,
    waitlistOrigins: opts.origins ?? ['https://tegata.ai'],
    waitlistRpm: opts.rpm ?? 0,
  });
  await app.ready();
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v1/waitlist',
      headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
  return { app, store, clock, post, close: async () => { await app.close(); store.close(); } };
};

describe('signing up', () => {
  it('accepts an address and keeps it', async () => {
    const r = await rig();
    const res = await r.post({ email: 'Founder@Example.COM ' });
    expect(res.statusCode).toBe(202);
    expect(r.store.waitlistCount()).toBe(1);
    expect(r.store.waitlistEntries()[0]!.email).toBe('founder@example.com');
    await r.close();
  });

  it('answers the same whether the address is new or already known', async () => {
    const r = await rig();
    const first = await r.post({ email: 'a@example.com' });
    const second = await r.post({ email: 'a@example.com' });
    // Identical replies: otherwise this endpoint tells a stranger who has signed up.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
    expect(r.store.waitlistCount()).toBe(1);
    await r.close();
  });

  it('treats one mailbox spelled two ways as one signup', async () => {
    const r = await rig();
    await r.post({ email: 'first.last@gmail.com' });
    await r.post({ email: 'firstlast+tegata@gmail.com' });
    expect(r.store.waitlistCount()).toBe(1);
    await r.close();
  });

  it('keeps distinct people distinct on domains that do not collapse addresses', async () => {
    const r = await rig();
    await r.post({ email: 'first.last@company.com' });
    await r.post({ email: 'firstlast@company.com' });
    expect(r.store.waitlistCount()).toBe(2);
    await r.close();
  });

  it('rejects what will never deliver, and says why to the person who typed it', async () => {
    const r = await rig();
    for (const email of ['', 'nope', 'a@b', 'x'.repeat(300) + '@b.co']) {
      const res = await r.post({ email });
      expect(res.statusCode, email).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_email' } });
    }
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  it('ignores fields it was not offered', async () => {
    const r = await rig();
    await r.post({ email: 'a@example.com', unsubscribed_at: '2020-01-01', id: 'attacker' });
    const row = r.store.waitlistEntries()[0]!;
    expect(row.id).not.toBe('attacker');
    expect(r.store.waitlistCount()).toBe(1);
    await r.close();
  });

  it('records the locale and source, truncated', async () => {
    const r = await rig();
    await r.post({ email: 'a@example.com', locale: 'ja', source: 'x'.repeat(100) });
    const row = r.store.waitlistEntries()[0]!;
    expect(row.locale).toBe('ja');
    expect(row.source.length).toBe(32);
    await r.close();
  });
});

describe('what it refuses', () => {
  it('accepts a request from an allowed origin and refuses an unknown one', async () => {
    const r = await rig({ origins: ['https://tegata.ai'] });
    const good = await r.post({ email: 'a@example.com' }, { origin: 'https://tegata.ai' });
    expect(good.statusCode).toBe(202);
    expect(good.headers['access-control-allow-origin']).toBe('https://tegata.ai');

    const bad = await r.post({ email: 'b@example.com' }, { origin: 'https://evil.example' });
    expect(bad.statusCode).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.store.waitlistCount()).toBe(1);
    await r.close();
  });

  it('answers a preflight only for an origin it allows', async () => {
    const r = await rig({ origins: ['https://tegata.ai'] });
    const ok = await r.app.inject({ method: 'OPTIONS', url: '/v1/waitlist',
      headers: { origin: 'https://tegata.ai' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-methods']).toContain('POST');

    const no = await r.app.inject({ method: 'OPTIONS', url: '/v1/waitlist',
      headers: { origin: 'https://evil.example' } });
    expect(no.statusCode).toBe(403);
    await r.close();
  });

  /**
   * The form sends JSON under a safelisted content type so the browser skips the
   * preflight — the round trip that used to sit in front of the confirmation. That only
   * works if the server reads it, so this is the test that keeps it working.
   */
  it('reads a JSON body sent as text/plain, so the form needs no preflight', async () => {
    const r = await rig();
    const res = await r.post({ email: 'simple@example.com' },
      { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://tegata.ai' });
    expect(res.statusCode).toBe(202);
    expect(r.store.waitlistEntries()[0]!.email).toBe('simple@example.com');
    await r.close();
  });

  it('still refuses an origin it does not allow, preflight or not', async () => {
    const r = await rig({ origins: ['https://tegata.ai'] });
    const res = await r.post({ email: 'founder@example.com' },
      { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  it('refuses a text/plain body that is not JSON', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'POST', url: '/v1/waitlist',
      headers: { 'content-type': 'text/plain' }, payload: 'founder@example.com' });
    expect(res.statusCode).toBe(400);
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  /**
   * The page is meant to work with no script behind it. Without a parser for what a
   * plain form posts, this route answered 500 and dropped the address — and nothing in
   * the browser would have said so.
   */
  it('accepts a plain form post, and answers it in a sentence', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'POST', url: '/v1/waitlist',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=nojs%40example.com&company_website=&locale=en&source=site' });
    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('You are on the list');
    expect(r.store.waitlistEntries()[0]!.email).toBe('nojs@example.com');
    await r.close();
  });

  it('tells a form post what was wrong with the address, in the same voice', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'POST', url: '/v1/waitlist',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=not-an-address' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('did not look right');
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  it('keeps the honeypot silent for a form post too', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'POST', url: '/v1/waitlist',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=bot%40example.com&company_website=http%3A%2F%2Fspam' });
    // Same 202 and the same words as a real signup; nothing stored.
    expect(res.statusCode).toBe(202);
    expect(res.body).toContain('You are on the list');
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  it('swallows a bot that fills in the field no person can see', async () => {
    const r = await rig();
    const res = await r.post({ email: 'bot@example.com', company_website: 'http://spam' });
    // Looks like success to the bot; stores nothing.
    expect(res.statusCode).toBe(202);
    expect(r.store.waitlistCount()).toBe(0);
    await r.close();
  });

  it('throttles one caller submitting faster than a person could', async () => {
    const r = await rig({ rpm: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await r.post({ email: `a${i}@example.com` })).statusCode).toBe(202);
    }
    const limited = await r.post({ email: 'a9@example.com' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    r.clock.advance(60_000);
    expect((await r.post({ email: 'later@example.com' })).statusCode).toBe(202);
    await r.close();
  });
});

describe('reading the list back', () => {
  it('needs the tenant key', async () => {
    const r = await rig();
    await r.post({ email: 'a@example.com' });
    for (const url of ['/v1/waitlist/export', '/v1/waitlist/count']) {
      expect((await r.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    await r.close();
  });

  it('exports CSV that survives an address containing a comma or a quote', async () => {
    const r = await rig();
    await r.post({ email: 'a@example.com' });
    r.store.addToWaitlist({ emailHash: 'h2', email: 'we"ird@example.com', source: 'a,b', locale: null, note: null });

    const res = await r.app.inject({ method: 'GET', url: '/v1/waitlist/export',
      headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('id,email,source,locale,created_at');
    expect(lines).toHaveLength(3);
    expect(res.body).toContain('"we""ird@example.com"');
    expect(res.body).toContain('"a,b"');
    await r.close();
  });

  it('counts only people who are still on the list', async () => {
    const r = await rig();
    await r.post({ email: 'stays@example.com' });
    await r.post({ email: 'leaves@example.com' });
    r.store.removeFromWaitlist(sha256Hex('leaves@example.com'));
    const res = await r.app.inject({ method: 'GET', url: '/v1/waitlist/count',
      headers: { authorization: `Bearer ${KEY}` } });
    expect(res.json()).toEqual({ count: 1 });
    await r.close();
  });
});

describe('the ledger stays free of personal data', () => {
  it('writes no register entry for a signup', async () => {
    const r = await rig();
    await r.post({ email: 'a@example.com' });
    const rows = r.store.db.prepare('SELECT COUNT(*) AS n FROM register').get() as { n: number };
    expect(rows.n).toBe(0);
    await r.close();
  });
});
