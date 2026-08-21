import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliverDue, envelope, type Fetcher } from './events.js';
import { grant, harness, TENANT } from './testkit.js';

type H = Awaited<ReturnType<typeof harness>>;

const withWebhook = async (secret = 'whsec'): Promise<H> => {
  const h = await harness();
  h.store.updateTenant(TENANT, { webhook_url: 'https://tenant.example/hook', webhook_secret: secret });
  return h;
};

interface Sent { url: string; headers: Record<string, string>; body: string; }

const recorder = (ok = true): { fetcher: Fetcher; sent: Sent[] } => {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { ok, status: ok ? 200 : 500 };
  };
  return { fetcher, sent };
};

const addRule = (h: H, over: Record<string, unknown> = {}): Promise<unknown> =>
  h.put('/v1/rules/low_balance_offer', {
    on: 'balance.low', when: {}, cooldown_hours: 72, holdout_pct: 0,
    action: { type: 'webhook' }, ...over,
  });

describe('balance signals', () => {
  it('fires on the crossing, not on every settlement', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);                      // threshold is 20% = 200
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 700 });
    expect(h.store.eventsOfType(TENANT, 'balance.low')).toHaveLength(0);

    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 150 });
    expect(h.store.eventsOfType(TENANT, 'balance.low')).toHaveLength(1);

    // Already below: crossing again must not re-fire.
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 10 });
    expect(h.store.eventsOfType(TENANT, 'balance.low')).toHaveLength(1);
    await h.close();
  });

  it('reports depletion distinctly from a low balance', async () => {
    const h = await harness();
    await grant(h, 'u1', 100);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 100 });
    expect(h.store.eventsOfType(TENANT, 'balance.depleted')).toHaveLength(1);
    await h.close();
  });

  it('reports repeated refusals once the threshold is reached', async () => {
    const h = await harness();
    await grant(h, 'u1', 1);
    for (let i = 0; i < 3; i++) {
      await h.post('/v1/authorizations', { subject_id: 'u1', action: 'image.generate' });
    }
    expect(h.store.eventsOfType(TENANT, 'authorization.dishonored')).toHaveLength(3);
    expect(h.store.eventsOfType(TENANT, 'dishonor.repeated').length).toBeGreaterThanOrEqual(1);
    await h.close();
  });
});

describe('delivery', () => {
  it('signs the body with a timestamp the receiver can check', async () => {
    const h = await withWebhook('whsec');
    await grant(h, 'u1', 100);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 100 });

    const { fetcher, sent } = recorder();
    const res = await deliverDue(h.store, fetcher);
    expect(res.delivered).toBeGreaterThan(0);

    const first = sent[0]!;
    const sig = first.headers['tegata-signature']!;
    const [tPart, vPart] = sig.split(',');
    const t = Number(tPart!.slice(2));
    const expected = createHmac('sha256', 'whsec').update(`${t}.${first.body}`).digest('hex');
    expect(vPart!.slice(3)).toBe(expected);
    expect(JSON.parse(first.body)).toMatchObject({ type: 'balance.depleted', subject_id: 'u1' });
    await h.close();
  });

  it('retries with backoff and gives up rather than looping forever', async () => {
    const h = await withWebhook();
    await grant(h, 'u1', 100);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 100 });
    const { fetcher } = recorder(false);

    for (let attempt = 0; attempt < 6; attempt++) {
      await deliverDue(h.store, fetcher);
      h.clock.advance(7 * 3_600_000);
    }
    const row = h.store.db.prepare(
      "SELECT attempts, next_attempt_at, delivered_at FROM event_outbox WHERE type = 'balance.depleted'",
    ).get() as { attempts: number; next_attempt_at: string | null; delivered_at: string | null };
    expect(row.attempts).toBeGreaterThanOrEqual(5);
    expect(row.delivered_at).toBeNull();
    expect(row.next_attempt_at).toBeNull();          // abandoned, not retried forever
    await h.close();
  });

  it('drops events for a tenant with no webhook configured, without retrying', async () => {
    const h = await harness();
    await grant(h, 'u1', 100);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 100 });
    const { fetcher, sent } = recorder();
    await deliverDue(h.store, fetcher);
    expect(sent).toHaveLength(0);
    const pending = h.store.dueEvents(h.store.now());
    expect(pending).toHaveLength(0);
    await h.close();
  });

  it('wraps the payload in a stable envelope', async () => {
    const h = await harness();
    const id = h.store.enqueueEvent(TENANT, 'balance.low', 'u1', { balance: 5 });
    const ev = h.store.dueEvents(h.store.now()).find((e) => e.event_id === id)!;
    expect(envelope(ev)).toMatchObject({ id, type: 'balance.low', subject_id: 'u1', data: { balance: 5 } });
    await h.close();
  });
});

describe('intervention rules', () => {
  it('fires on a matching event and enqueues the intervention', async () => {
    const h = await withWebhook();
    await addRule(h);
    await grant(h, 'u1', 1000);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 850 });

    const firings = await h.get('/v1/rules/low_balance_offer/firings');
    expect((firings.body.firings as unknown[]).length).toBe(1);
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(1);
    await h.close();
  });

  it('respects the cooldown so one subject is not repeatedly hit', async () => {
    const h = await withWebhook();
    await addRule(h, { cooldown_hours: 72 });
    await grant(h, 'u1', 1000);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 850 });
    await h.post('/v1/subjects/u1/grants', { credits: 1000 });
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 900 });
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(1);

    h.clock.advance(73 * 3_600_000);
    await h.post('/v1/subjects/u1/grants', { credits: 1000 });
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 900 });
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(2);
    await h.close();
  });

  it('skips subjects that do not satisfy the condition', async () => {
    const h = await withWebhook();
    await addRule(h, { when: { 'subject.lifetime_credits_purchased': { gt: 0 } } });
    await grant(h, 'u1', 1000);                       // source 'grant', not a purchase
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 850 });
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(0);
    await h.close();
  });

  it('records a holdout firing but withholds the action, so the effect is measurable', async () => {
    const h = await withWebhook();
    await addRule(h, { holdout_pct: 50 });
    // Assignment is a stable hash of tenant, rule and subject, so a subject stays in
    // its arm across events and across restarts.
    const arms = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const s = `user_${i}`;
      await h.post(`/v1/subjects/${s}/grants`, { credits: 1000 });
      await h.post('/v1/usage', { subject_id: s, action: 'image.generate', amount: 850 });
    }
    const firings = h.store.db.prepare(
      'SELECT subject_id, holdout FROM rule_firing WHERE rule_id = ?',
    ).all('low_balance_offer') as { subject_id: string; holdout: number }[];
    expect(firings.length).toBe(40);
    for (const f of firings) arms.set(f.subject_id, f.holdout);
    const held = firings.filter((f) => f.holdout === 1).length;
    // Not exactly 20, but both arms must be populated or the comparison is worthless.
    expect(held).toBeGreaterThan(5);
    expect(held).toBeLessThan(35);
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(40 - held);
    await h.close();
  });

  it('assigns a subject to the same arm every time', async () => {
    const armsFor = async (): Promise<number> => {
      const h = await withWebhook();
      await addRule(h, { holdout_pct: 50 });
      await h.post('/v1/subjects/stable-user/grants', { credits: 1000 });
      await h.post('/v1/usage', { subject_id: 'stable-user', action: 'image.generate', amount: 850 });
      const row = h.store.db.prepare(
        'SELECT holdout FROM rule_firing WHERE subject_id = ?',
      ).get('stable-user') as { holdout: number };
      await h.close();
      return row.holdout;
    };
    expect(await armsFor()).toBe(await armsFor());
  });

  it('ignores a disabled rule', async () => {
    const h = await withWebhook();
    await addRule(h, { enabled: false });
    await grant(h, 'u1', 1000);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 850 });
    expect(h.store.eventsOfType(TENANT, 'intervention')).toHaveLength(0);
    await h.close();
  });
});
