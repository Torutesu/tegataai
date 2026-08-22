import { describe, expect, it } from 'vitest';
import { signatureFor } from './events.js';
import { verifyStripeSignature } from './stripe.js';
import { grant, harness, TENANT } from './testkit.js';

const invoice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1',
  type: 'invoice.paid',
  data: {
    object: {
      customer: 'cus_A',
      amount_paid: 2000,                       // $20.00 in cents
      period_start: Date.parse('2026-08-01T00:00:00.000Z') / 1000,
      period_end: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
      metadata: { tegata_subject_id: 'u1' },
      lines: { data: [{ price: { id: 'price_pro' } }] },
      ...(over.object ?? {}),
    },
  },
  ...over,
});

const withRule = async (): Promise<Awaited<ReturnType<typeof harness>>> => {
  const h = await harness();
  h.store.updateTenant(TENANT, { webhook_secret: WHSEC });
  h.store.db.prepare(
    'INSERT INTO credit_grant_rule (tenant_id,stripe_price_id,credits_per_period,refresh_policy,rollover_cap_credits,priority) VALUES (?,?,?,?,?,?)',
  ).run(TENANT, 'price_pro', 1000, 'reset', null, 10);
  return h;
};

const WHSEC = 'whsec_test';

/** Signed the way Stripe signs: over the exact bytes being sent. */
const send = (h: Awaited<ReturnType<typeof harness>>, body: unknown) => {
  const payload = JSON.stringify(body);
  const t = Math.floor(h.store.nowMs() / 1000);
  return h.app.inject({
    method: 'POST', url: '/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json', 'tegata-tenant': TENANT,
      'stripe-signature': signatureFor(WHSEC, t, payload),
    },
    payload,
  });
};

describe('stripe entitlement sync', () => {
  it('grants on invoice.paid, not on subscription creation', async () => {
    const h = await withRule();
    const res = await send(h, invoice());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handled: 'invoice.paid', subject_id: 'u1', credits: 1000 });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1000);
    await h.close();
  });

  it('grants exactly once however many times the event is redelivered (AC-08)', async () => {
    const h = await withRule();
    for (let i = 0; i < 10; i++) await send(h, invoice());
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1000);
    const rows = h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlement').get() as { n: number };
    expect(rows.n).toBe(1);
    await h.close();
  });

  it('records revenue for the invoice period, in micro-USD', async () => {
    const h = await withRule();
    await send(h, invoice());
    const rev = h.store.revenueEvents(TENANT);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ kind: 'subscription', amount_micro_usd: 20_000_000 });
    await h.close();
  });

  it('lapses the previous period under a reset policy', async () => {
    const h = await withRule();
    await send(h, invoice());
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 200 });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(800);

    await send(h, { ...invoice(), id: 'evt_2' });
    // Reset: the 800 unused lapse, then 1000 fresh.
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1000);
    await h.close();
  });

  it('carries the remainder under a rollover policy', async () => {
    const h = await harness();
    h.store.updateTenant(TENANT, { webhook_secret: WHSEC });
    h.store.db.prepare(
      'INSERT INTO credit_grant_rule (tenant_id,stripe_price_id,credits_per_period,refresh_policy,rollover_cap_credits,priority) VALUES (?,?,?,?,?,?)',
    ).run(TENANT, 'price_pro', 1000, 'rollover', null, 10);
    await send(h, invoice());
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 200 });
    await send(h, { ...invoice(), id: 'evt_2' });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1800);
    await h.close();
  });

  it('caps the carry under rollover_capped and lapses the excess', async () => {
    const h = await harness();
    h.store.updateTenant(TENANT, { webhook_secret: WHSEC });
    h.store.db.prepare(
      'INSERT INTO credit_grant_rule (tenant_id,stripe_price_id,credits_per_period,refresh_policy,rollover_cap_credits,priority) VALUES (?,?,?,?,?,?)',
    ).run(TENANT, 'price_pro', 1000, 'rollover_capped', 300, 10);
    await send(h, invoice());
    await send(h, { ...invoice(), id: 'evt_2' });
    // The cap is applied to the previous period's remainder before the new grant lands.
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1300);
    await h.close();
  });

  it('signals an unmatched customer instead of dropping the payment', async () => {
    const h = await withRule();
    const res = await send(h, {
      id: 'evt_x', type: 'invoice.paid',
      data: { object: { customer: 'cus_unknown', amount_paid: 2000, lines: { data: [] }, metadata: {} } },
    });
    expect(res.statusCode).toBe(200);
    expect(h.store.eventsOfType(TENANT, 'stripe.unmatched_customer')).toHaveLength(1);
    await h.close();
  });

  it('grants a top-up from a completed checkout session', async () => {
    const h = await withRule();
    await send(h, invoice());
    await send(h, {
      id: 'evt_top', type: 'checkout.session.completed',
      data: { object: { mode: 'payment', customer: 'cus_A', amount_total: 1000,
        metadata: { tegata_subject_id: 'u1', tegata_credits: '500' } } },
    });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(1500);
    expect(h.store.revenueEvents(TENANT).filter((r) => r.kind === 'topup')).toHaveLength(1);
    await h.close();
  });

  it('revokes subscription credits when the subscription is deleted', async () => {
    const h = await withRule();
    await send(h, invoice());
    await send(h, {
      id: 'evt_del', type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_A', metadata: { tegata_subject_id: 'u1' } } },
    });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(0);
    await h.close();
  });

  it('acknowledges events it does not act on', async () => {
    const h = await withRule();
    const res = await send(h, { id: 'evt_other', type: 'customer.subscription.updated', data: { object: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handled: 'customer.subscription.updated' });
    await h.close();
  });
});

describe('stripe signature', () => {
  const secret = 'whsec_test';
  const now = Date.parse('2026-08-21T00:00:00.000Z');
  const payload = '{"id":"evt_1"}';

  it('accepts a signature inside the tolerance', () => {
    const t = Math.floor(now / 1000);
    const header = signatureFor(secret, t, payload);
    expect(() => verifyStripeSignature(payload, header, secret, now)).not.toThrow();
  });

  it('rejects a stale timestamp, which is what makes replay expensive', () => {
    const t = Math.floor(now / 1000) - 600;
    expect(() => verifyStripeSignature(payload, signatureFor(secret, t, payload), secret, now))
      .toThrow(/tolerance/);
  });

  it('rejects a forged signature and a malformed header', () => {
    const t = Math.floor(now / 1000);
    expect(() => verifyStripeSignature(payload, `t=${t},v1=deadbeef`, secret, now)).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(payload, 'garbage', secret, now)).toThrow(/Malformed/);
  });

  /**
   * Stripe signs with both the old and the new secret while one is being rotated, so a
   * genuine delivery arrives with two v1 values and only one of them is ours. Reading
   * the header as a plain object keeps whichever came last, which rejects half of them.
   */
  it('accepts a header carrying more than one signature, as a rotation sends', () => {
    const t = Math.floor(now / 1000);
    const ours = signatureFor(secret, t, payload).split(',').find((p) => p.startsWith('v1='));
    expect(() => verifyStripeSignature(payload, `t=${t},${ours},v1=${'0'.repeat(64)}`, secret, now)).not.toThrow();
    expect(() => verifyStripeSignature(payload, `t=${t},v1=${'0'.repeat(64)},${ours}`, secret, now)).not.toThrow();
  });

  it('still refuses a header where none of the signatures are ours', () => {
    const t = Math.floor(now / 1000);
    expect(() => verifyStripeSignature(payload, `t=${t},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, secret, now))
      .toThrow(/mismatch/);
  });

  it('rejects a header with a timestamp but no signature at all', () => {
    const t = Math.floor(now / 1000);
    expect(() => verifyStripeSignature(payload, `t=${t}`, secret, now)).toThrow(/Malformed/);
    expect(() => verifyStripeSignature(payload, `t=${t},v0=abc`, secret, now)).toThrow(/Malformed/);
  });

  it('rejects a signature over different bytes', () => {
    const t = Math.floor(now / 1000);
    const header = signatureFor(secret, t, payload);
    expect(() => verifyStripeSignature('{"id":"evt_2"}', header, secret, now)).toThrow(/mismatch/);
  });
});

describe('sweeping', () => {
  it('lets a matured hold lapse and returns the reservation (T5)', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate', maturity_seconds: 60 });
    expect((await h.get('/v1/subjects/u1')).body).toMatchObject({ reserved: 40, available: 960 });

    h.clock.advance(61_000);
    const sweep = await h.post('/v1/admin/sweep', {});
    expect(sweep.body.authorizations_expired).toBe(1);
    // The balance never moved: a lapsed hold is not a settlement.
    expect((await h.get('/v1/subjects/u1')).body).toMatchObject({ balance: 1000, reserved: 0, available: 1000 });
    expect(h.store.verifySubjectChain(TENANT, 'u1')).toEqual({ ok: true });
    await h.close();
  });

  it('lapses an expired entitlement and takes the unused remainder off the balance', async () => {
    const h = await harness();
    await h.post('/v1/subjects/u1/grants', { credits: 500, expires_at: '2026-08-22T00:00:00.000Z' });
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(500);

    h.clock.advance(2 * 86_400_000);
    const sweep = await h.post('/v1/admin/sweep', {});
    expect(sweep.body.entitlements_expired).toBe(1);
    expect((await h.get('/v1/subjects/u1')).body.balance).toBe(0);
    await h.close();
  });

  it('purges idempotency keys once they are older than the retention window', async () => {
    const h = await harness();
    await grant(h, 'u1', 100);
    h.clock.advance(25 * 3_600_000);
    const sweep = await h.post('/v1/admin/sweep', {});
    expect(sweep.body.idempotency_purged as number).toBeGreaterThan(0);
    await h.close();
  });

  it('keeps the projection honest across a sweep', async () => {
    const h = await harness();
    await grant(h, 'u1', 300);
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate', maturity_seconds: 30 });
    h.clock.advance(31_000);
    await h.post('/v1/admin/sweep', {});
    const live = h.store.balances(TENANT, 'u1');
    expect(h.store.rebuildProjection(TENANT, 'u1')).toEqual(live);
    await h.close();
  });
});
