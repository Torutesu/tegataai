import { describe, expect, it } from 'vitest';
import { verifyExport } from '@tegata/verify';
import { grant, harness, OPUS, TENANT } from './testkit.js';

describe('register export', () => {
  it('verifies offline with the shipped verifier, and fails after one altered byte', async () => {
    const h = await harness();
    await grant(h, 'u1', 1000);
    await grant(h, 'u2', 500);
    const a = await h.post('/v1/authorizations', {
      subject_id: 'u1', action: 'chat.completion',
      estimate: { ...OPUS, input_tokens: 20_000, max_output_tokens: 2_000 },
    });
    await h.post(`/v1/authorizations/${a.body.authorization_id as string}/capture`, {
      actual: { input_tokens: 20_000, output_tokens: 900 }, ...OPUS,
    });
    await h.post('/v1/usage', { subject_id: 'u2', action: 'image.generate', amount: 30 });

    const exported = await h.get('/v1/register/export');
    expect(exported.headers['content-type']).toContain('application/jsonl');

    const report = verifyExport(exported.text);
    expect(report.ok).toBe(true);
    expect(report.manifestChecked).toBe(true);
    expect(report.subjects).toBe(2);
    expect(report.balances.u2!.balance).toBe(470);

    const lines = exported.text.trim().split('\n');
    const victim = JSON.parse(lines[1]!) as Record<string, unknown>;
    victim.delta_amount = Number(victim.delta_amount) - 1;
    lines[1] = JSON.stringify(victim);
    expect(verifyExport(lines.join('\n')).ok).toBe(false);
    await h.close();
  });

  it('carries a manifest whose roots match the chain heads', async () => {
    const h = await harness();
    await grant(h, 'u1', 100);
    const exported = await h.get('/v1/register/export');
    const lines = exported.text.trim().split('\n');
    const manifest = JSON.parse(lines[lines.length - 1]!) as {
      manifest: boolean; entries: number; roots: { subject_id: string; hash: string }[];
    };
    expect(manifest.manifest).toBe(true);
    expect(manifest.entries).toBe(lines.length - 1);
    const head = JSON.parse(lines[lines.length - 2]!) as { hash: string };
    expect(manifest.roots[0]!.hash).toBe(head.hash);
    await h.close();
  });
});

describe('margin', () => {
  it('matches a hand-computed figure, in integers throughout', async () => {
    const h = await harness();
    // Two subjects paying $20 for a 30-day period that exactly covers the window.
    for (const s of ['heavy', 'light']) {
      h.store.recordRevenue(TENANT, s, 'subscription', 20_000_000,
        '2026-08-21T00:00:00.000Z', '2026-09-20T00:00:00.000Z', null);
      await grant(h, s, 2000);
    }
    // heavy burns $30 of provider cost, light burns $2.
    await h.post('/v1/usage', { subject_id: 'heavy', action: 'image.generate', amount: 1500, cost_micro_usd: 30_000_000 });
    await h.post('/v1/usage', { subject_id: 'light', action: 'image.generate', amount: 100, cost_micro_usd: 2_000_000 });
    h.clock.advance(30 * 86_400_000);

    const res = await h.get('/v1/metrics/margin?window_days=30');
    const byId = Object.fromEntries((res.body.subjects as { subject_id: string }[]).map((s) => [s.subject_id, s]));
    expect(byId.heavy).toMatchObject({
      revenue_micro_usd: 20_000_000, cost_micro_usd: 30_000_000,
      margin_micro_usd: -10_000_000, negative: true,
    });
    expect(byId.light).toMatchObject({
      revenue_micro_usd: 20_000_000, cost_micro_usd: 2_000_000,
      margin_micro_usd: 18_000_000, negative: false,
    });
    expect(res.body.summary).toMatchObject({
      subjects: 2, negative_count: 1,
      negative_share_milli: 500,               // 1 of 2
      negative_cost_share_milli: 938,          // 30M of 32M
    });
    for (const v of Object.values(res.body.summary as Record<string, number>)) {
      expect(Number.isSafeInteger(v)).toBe(true);
    }
    await h.close();
  });

  it('prorates a subscription across the window rather than counting it whole', async () => {
    const h = await harness();
    // A 30-day period starting halfway through a 30-day window: half recognised.
    h.store.recordRevenue(TENANT, 'u1', 'subscription', 30_000_000,
      '2026-09-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', null);
    await grant(h, 'u1', 100);
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 10, cost_micro_usd: 1_000 });
    h.clock.advance(35 * 86_400_000);            // now 2026-09-25

    const res = await h.get('/v1/metrics/margin?window_days=30');
    const s = (res.body.subjects as { subject_id: string; revenue_micro_usd: number }[])[0]!;
    // Window 2026-08-26..09-25 overlaps the period for 20 of its 30 days.
    expect(s.revenue_micro_usd).toBe(20_000_000);
    await h.close();
  });

  it('counts a promotional grant as zero revenue, so it cannot flatter the margin', async () => {
    const h = await harness();
    await h.post('/v1/subjects/u1/grants', { credits: 1000, source: 'promo' });
    await h.post('/v1/usage', { subject_id: 'u1', action: 'image.generate', amount: 100, cost_micro_usd: 5_000_000 });
    const res = await h.get('/v1/metrics/margin?window_days=30');
    expect((res.body.subjects as { negative: boolean; revenue_micro_usd: number }[])[0])
      .toMatchObject({ revenue_micro_usd: 0, negative: true });
    await h.close();
  });

  it('reports an empty window without dividing by zero', async () => {
    const h = await harness();
    const res = await h.get('/v1/metrics/margin?window_days=30');
    expect(res.body.summary).toMatchObject({
      subjects: 0, negative_count: 0, negative_share_milli: 0, negative_cost_share_milli: 0,
    });
    await h.close();
  });

  it('rejects a nonsense window', async () => {
    const h = await harness();
    expect((await h.get('/v1/metrics/margin?window_days=0')).status).toBe(400);
    expect((await h.get('/v1/metrics/margin?window_days=abc')).status).toBe(400);
    await h.close();
  });
});
