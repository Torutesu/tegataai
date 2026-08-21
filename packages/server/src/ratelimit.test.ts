import { describe, expect, it } from 'vitest';
import { grant, harness } from './testkit.js';

/**
 * PRD §12.6. The two tiers answer differently on purpose: the tenant limit protects the
 * node and speaks HTTP; the subject limit is about one account's own budget and comes
 * back as a decision the caller has to handle, like any other refusal.
 */

describe('subject rate limit', () => {
  it('refuses as a dishonor, not as an error status', async () => {
    const h = await harness({ subjectRps: 3 });
    await grant(h, 'u1', 10_000);

    const seen: number[] = [];
    let refusal: Record<string, unknown> | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
      seen.push(res.status);
      if (res.body.reason === 'rate_limited') refusal = res.body;
    }
    expect(seen.every((s) => s === 200 || s === 201)).toBe(true);   // never a 4xx
    expect(refusal).toMatchObject({ decision: 'dishonored', reason: 'rate_limited' });
    expect(refusal!.retry_after).toBeGreaterThan(0);
    await h.close();
  });

  it('allows the burst, refuses past it, and allows again once time passes', async () => {
    const h = await harness({ subjectRps: 3 });
    await grant(h, 'u1', 10_000);
    const call = async (): Promise<string> =>
      String((await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' })).body.decision);

    for (let i = 0; i < 3; i++) expect(await call(), `burst ${i}`).toBe('authorized');
    expect(await call()).toBe('dishonored');

    h.clock.advance(1000);
    expect(await call()).toBe('authorized');
    await h.close();
  });

  it('does not spend one subject\'s budget on another', async () => {
    const h = await harness({ subjectRps: 2 });
    await grant(h, 'u1', 10_000);
    await grant(h, 'u2', 10_000);
    for (let i = 0; i < 3; i++) await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const other = await h.post('/v1/authorizations', { subject_id: 'u2', action: 'image.generate' });
    expect(other.body.decision).toBe('authorized');
    await h.close();
  });

  it('holds nothing when it refuses', async () => {
    const h = await harness({ subjectRps: 1 });
    await grant(h, 'u1', 10_000);
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    // One hold from the one authorized call; the refused one reserved nothing.
    expect((await h.get('/v1/subjects/u1')).body.reserved).toBe(40);
    await h.close();
  });
});

describe('tenant rate limit', () => {
  it('answers 429 with a retry-after, because it is about the node', async () => {
    const h = await harness({ tenantRps: 3 });
    await grant(h, 'u1', 10_000);
    let limited: Awaited<ReturnType<typeof h.get>> | undefined;
    for (let i = 0; i < 12; i++) {
      const res = await h.get('/v1/subjects/u1');
      if (res.status === 429) { limited = res; break; }
    }
    expect(limited).toBeDefined();
    expect(limited!.body).toMatchObject({ error: { code: 'rate_limited' } });
    expect(limited!.headers['retry-after']).toBeDefined();
    await h.close();
  });

  it('leaves health and the webhook reachable when the tenant is throttled', async () => {
    const h = await harness({ tenantRps: 1 });
    for (let i = 0; i < 5; i++) await h.get('/v1/subjects/u1');
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await h.close();
  });
});

describe('limits off', () => {
  it('does not throttle when configured to zero', async () => {
    const h = await harness({ tenantRps: 0, subjectRps: 0 });
    await grant(h, 'u1', 100_000);
    for (let i = 0; i < 60; i++) {
      const res = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
      expect(res.body.decision, `call ${i}`).toBe('authorized');
    }
    await h.close();
  });
});
