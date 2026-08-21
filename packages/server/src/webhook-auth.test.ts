import { describe, expect, it } from 'vitest';
import { signatureFor } from './events.js';
import { harness, TENANT } from './testkit.js';

/**
 * The webhook mints credits. Everything here is about who is allowed to make it do that.
 */

const invoice = (id = 'evt_forged') => ({
  id, type: 'invoice.paid',
  data: { object: {
    customer: 'cus_A', amount_paid: 2000,
    metadata: { tegata_subject_id: 'victim' },
    lines: { data: [{ price: { id: 'price_pro' } }] },
  } },
});

const withSecret = async (secret: string | null) => {
  const h = await harness();
  h.store.updateTenant(TENANT, { webhook_secret: secret });
  h.store.db.prepare(
    'INSERT INTO credit_grant_rule (tenant_id,stripe_price_id,credits_per_period,refresh_policy,rollover_cap_credits,priority) VALUES (?,?,?,?,?,?)',
  ).run(TENANT, 'price_pro', 100000, 'reset', null, 10);
  return h;
};

const send = (h: Awaited<ReturnType<typeof harness>>, body: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST', url: '/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'tegata-tenant': TENANT, ...headers },
    payload: JSON.stringify(body),
  });

const balanceOf = (h: Awaited<ReturnType<typeof harness>>, subject: string): number =>
  h.store.balances(TENANT, subject).balance;

describe('the webhook refuses anything it cannot authenticate', () => {
  it('refuses a request with no signature at all', async () => {
    const h = await withSecret('whsec_real');
    const res = await send(h, invoice());
    expect(res.statusCode).toBe(401);
    expect(balanceOf(h, 'victim')).toBe(0);
    await h.close();
  });

  it('refuses a forged signature', async () => {
    const h = await withSecret('whsec_real');
    const t = Math.floor(h.store.nowMs() / 1000);
    const res = await send(h, invoice(), { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` });
    expect(res.statusCode).toBe(400);
    expect(balanceOf(h, 'victim')).toBe(0);
    await h.close();
  });

  it('refuses a signature made with the wrong secret', async () => {
    const h = await withSecret('whsec_real');
    const t = Math.floor(h.store.nowMs() / 1000);
    const body = JSON.stringify(invoice());
    const res = await send(h, invoice(), { 'stripe-signature': signatureFor('whsec_attacker', t, body) });
    expect(res.statusCode).toBe(400);
    expect(balanceOf(h, 'victim')).toBe(0);
    await h.close();
  });

  it('refuses when the tenant has no secret configured, rather than trusting the caller', async () => {
    const h = await withSecret(null);
    const res = await send(h, invoice());
    expect(res.statusCode).toBe(401);
    expect(balanceOf(h, 'victim')).toBe(0);
    await h.close();
  });

  it('refuses a replay from outside the tolerance window', async () => {
    const h = await withSecret('whsec_real');
    const body = JSON.stringify(invoice());
    const old = Math.floor(h.store.nowMs() / 1000) - 600;
    const res = await send(h, invoice(), { 'stripe-signature': signatureFor('whsec_real', old, body) });
    expect(res.statusCode).toBe(400);
    expect(balanceOf(h, 'victim')).toBe(0);
    await h.close();
  });

  it('refuses an unknown tenant without saying whether it exists', async () => {
    const h = await withSecret('whsec_real');
    const res = await h.app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'tegata-tenant': 'T9999999999999999999999999' },
      payload: JSON.stringify(invoice()),
    });
    expect(res.statusCode).toBe(401);
    await h.close();
  });

  it('accepts a correctly signed event, over the bytes that were actually sent', async () => {
    const h = await withSecret('whsec_real');
    // Bytes Stripe would send: not what JSON.stringify of the parsed body happens to produce.
    const body = '{"id":"evt_ok",  "type":"invoice.paid","data":{"object":{"customer":"cus_A",'
      + '"amount_paid":2000,"metadata":{"tegata_subject_id":"victim"},'
      + '"lines":{"data":[{"price":{"id":"price_pro"}}]}}}}';
    const t = Math.floor(h.store.nowMs() / 1000);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: {
        'content-type': 'application/json', 'tegata-tenant': TENANT,
        'stripe-signature': signatureFor('whsec_real', t, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(balanceOf(h, 'victim')).toBe(100000);
    await h.close();
  });
});
