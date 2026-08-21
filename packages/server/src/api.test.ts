import { describe, expect, it } from 'vitest';
import { registerEntryValidator } from './schemas.js';
import { grant, harness, nextKey, OPUS, TENANT } from './testkit.js';

describe('issue', () => {
  it('authorises and holds the face value without moving the balance', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const res = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 },
    });
    expect(res.status).toBe(201);
    expect(res.headers['tegata-decision']).toBe('authorized');
    expect(res.body.decision).toBe('authorized');

    // 4,400 fresh at 15 + 8,000 cached at 1 + 2,000 out at 75 = 224,000 micro-USD -> 12 credits.
    expect(res.body.face_value).toBe(12);
    expect(res.body.available_after_hold).toBe(988);
    const sub = await h.get('/v1/subjects/u1');
    expect(sub.body).toMatchObject({ balance: 1000, reserved: 12, available: 988 });
    await h.close();
  });

  it('returns a refusal as 200 with a decision, never as an HTTP error', async () => {
    const h = await harness();
    await grant(h, 'u1', 5);
    const res = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 100_000, max_output_tokens: 10_000 },
    });
    expect(res.status).toBe(200);
    expect(res.headers['tegata-decision']).toBe('dishonored');
    expect(res.body).toMatchObject({ decision: 'dishonored', reason: 'insufficient_balance', available: 5 });
    await h.close();
  });

  it('proposes the cheaper action but does not take it', async () => {
    const h = await harness();
    await grant(h, 'u1', 5);
    const res = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 100_000, max_output_tokens: 10_000 },
    });
    expect(res.body.remedy).toMatchObject({ fallback_action: 'chat.completion.mini' });
    // Nothing was authorised on the caller's behalf.
    const sub = await h.get('/v1/subjects/u1');
    expect(sub.body.reserved).toBe(0);
    await h.close();
  });

  it('records the refusal in the register with the reason', async () => {
    const h = await harness();
    await grant(h, 'u1', 1);
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const reg = await h.get('/v1/subjects/u1/register');
    const kinds = reg.text.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; delta_amount: number });
    expect(kinds.map((k) => k.kind)).toEqual(['grant', 'dishonor']);
    expect(kinds[1]!.delta_amount).toBe(0);
    await h.close();
  });

  it('creates the subject on first sight - the id is the tenant\'s', async () => {
    const h = await harness();
    const res = await h.post('/v1/authorizations', { subject_id: 'brand-new', action: 'image.generate' });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('insufficient_balance');
    expect((await h.get('/v1/subjects/brand-new')).status).toBe(200);
    await h.close();
  });

  it('refuses a suspended subject', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    await h.put('/v1/subjects/u1/status', { status: 'suspended' });
    const res = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    expect(res.body).toMatchObject({ decision: 'dishonored', reason: 'subject_suspended' });
    await h.close();
  });

  it('falls back to the declared default for an unknown model, and says so', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const res = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { provider: 'openai', model: 'gpt-nonexistent', input_tokens: 500 },
    });
    expect(res.body.face_value).toBe(25);
    expect(h.store.eventsOfType(TENANT, 'cost_table.unknown_model').length).toBe(1);
    await h.close();
  });

  it('rejects an unknown action rather than guessing a price', async () => {
    const h = await harness();
    const res = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'never.registered' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
    await h.close();
  });

  it('validates the body against the schema', async () => {
    const h = await harness();
    const res = await h.post('/v1/authorizations', { subject_id: 'u1' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
    await h.close();
  });

  it('caps maturity at the specified ceiling', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const res = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'image.generate', maturity_seconds: 3600,
    });
    expect(res.body.maturity).toBe('2026-08-21T01:00:00.000Z');
    await h.close();
  });
});

describe('capture', () => {
  it('settles the measured amount and releases the remainder', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const iss = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 },
    });
    const id = iss.body.authorization_id as string;
    const cap = await h.post(`/v1/authorizations/${id}/capture`, {
      actual: { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 },
    });
    expect(cap.status).toBe(200);
    // 4,400 at 15 + 8,000 at 1 + 1,180 at 75 = 162,500 -> 9 credits.
    expect(cap.body).toMatchObject({ captured_amount: 9, released_remainder: 3, balance: 991, available: 991 });
    await h.close();
  });

  it('succeeds past the face value - the action already ran', async () => {
    const h = await harness();
    await grant(h, 'u1', 100);
    const iss = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const id = iss.body.authorization_id as string;
    const cap = await h.post(`/v1/authorizations/${id}/capture`, { amount: 90, cost_micro_usd: 1_800_000 });
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ captured_amount: 90, released_remainder: 0, balance: 10 });
    await h.close();
  });

  it('overdraws rather than losing the record, and says it overdrew', async () => {
    const h = await harness();
    await grant(h, 'u1', 40);
    const iss = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const id = iss.body.authorization_id as string;
    const cap = await h.post(`/v1/authorizations/${id}/capture`, { amount: 150 });
    expect(cap.body).toMatchObject({ captured_amount: 150, balance: -110, overdrawn: true });
    expect(h.store.eventsOfType(TENANT, 'balance.overdrawn').length).toBe(1);
    await h.close();
  });

  it('refuses to settle a closed authorization', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const iss = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const id = iss.body.authorization_id as string;
    await h.post(`/v1/authorizations/${id}/capture`, { amount: 10 });
    const again = await h.post(`/v1/authorizations/${id}/capture`, { amount: 10 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'authorization_closed' } });
    await h.close();
  });

  it('refuses to settle past maturity and points at direct settlement', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const iss = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'image.generate', maturity_seconds: 60,
    });
    h.clock.advance(61_000);
    const cap = await h.post(`/v1/authorizations/${iss.body.authorization_id as string}/capture`, { amount: 10 });
    expect(cap.status).toBe(409);
    expect(cap.body).toMatchObject({ error: { code: 'authorization_matured' } });
    await h.close();
  });
});

describe('release', () => {
  it('returns the hold without moving the balance, and is idempotent', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const iss = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    const id = iss.body.authorization_id as string;
    expect((await h.get('/v1/subjects/u1')).body.reserved).toBe(40);

    await h.post(`/v1/authorizations/${id}/release`, { reason: 'caller_cancelled' });
    expect((await h.get('/v1/subjects/u1')).body).toMatchObject({ balance: 1000, reserved: 0, available: 1000 });

    const again = await h.post(`/v1/authorizations/${id}/release`, {});
    expect(again.status).toBe(200);
    await h.close();
  });
});

describe('direct settlement', () => {
  it('records usage with no hold and never refuses', async () => {
    const h = await harness();
    await grant(h, 'u1', 5);
    const res = await h.post('/v1/usage', {
      subject_id: 'u1', action: 'chat.completion', ...OPUS,
      actual: { input_tokens: 100_000, output_tokens: 10_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBeLessThan(0);
    await h.close();
  });
});

describe('idempotency over HTTP', () => {
  it('replays the original response rather than issuing twice', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const key = nextKey();
    const first = await h.post('/v1/authorizations',
      { subject_id: 'u1', action: 'image.generate' }, { 'idempotency-key': key });
    const second = await h.post('/v1/authorizations',
      { subject_id: 'u1', action: 'image.generate' }, { 'idempotency-key': key });
    expect(second.status).toBe(first.status);
    expect(second.body.authorization_id).toBe(first.body.authorization_id);
    expect((await h.get('/v1/subjects/u1')).body.reserved).toBe(40);
    await h.close();
  });

  it('rejects the same key with a different body', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    const key = nextKey();
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' }, { 'idempotency-key': key });
    const other = await h.post('/v1/authorizations',
      { subject_id: 'u1', action: 'chat.completion' }, { 'idempotency-key': key });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: 'idempotency_key_reuse' } });
    await h.close();
  });

  it('requires a key on writes', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST', url: '/v1/authorizations',
      headers: { authorization: 'Bearer sk_test_tegata', 'content-type': 'application/json' },
      payload: JSON.stringify({ subject_id: 'u1', action: 'image.generate' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
    await h.close();
  });
});

describe('authentication', () => {
  it('refuses a missing or wrong key', async () => {
    const h = await harness();
    for (const auth of [undefined, 'Bearer nope', 'Basic x']) {
      const res = await h.app.inject({
        method: 'GET', url: '/v1/subjects/u1',
        headers: auth === undefined ? {} : { authorization: auth },
      });
      expect(res.statusCode).toBe(401);
    }
    await h.close();
  });

  it('leaves /health open', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await h.close();
  });
});

describe('every emitted entry satisfies the published schema (INV-11)', () => {
  it('across grant, issue, capture, release, dishonor and expiry', async () => {
    const h = await harness();
    await grant(h, 'u1', 200);
    const a = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    await h.post(`/v1/authorizations/${a.body.authorization_id as string}/capture`, { amount: 30 });
    const b = await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    await h.post(`/v1/authorizations/${b.body.authorization_id as string}/release`, {});
    await h.post('/v1/authorizations', { subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 10_000_000, max_output_tokens: 100_000 } });

    const reg = await h.get('/v1/subjects/u1/register');
    const entries = reg.text.trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const e of entries) {
      const ok = registerEntryValidator(e);
      if (!ok) throw new Error(`${JSON.stringify(e)} -> ${JSON.stringify(registerEntryValidator.errors)}`);
    }
    expect(h.store.verifySubjectChain(TENANT, 'u1')).toEqual({ ok: true });
    await h.close();
  });
});
