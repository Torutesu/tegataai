import { describe, expect, it } from 'vitest';
import { harness } from './testkit.js';

describe('the authenticated surface', () => {
  it('lets nothing but health and the self-authenticating webhook through unauthenticated', async () => {
    const h = await harness();
    const paths = [
      '/v1/subjects/u1', '/v1/authorizations', '/v1/usage', '/v1/register/export',
      '/v1/metrics/margin', '/v1/rules', '/v1/admin/sweep', '/v1/cost-table',
      // A path that only looks like the webhook prefix.
      '/v1/webhooks/../register/export', '/v1/webhooks%2f../register/export',
    ];
    for (const url of paths) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await h.app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: '{}' });
        expect([401, 400, 404], `${method} ${url} answered ${res.statusCode}`).toContain(res.statusCode);
        if (res.statusCode === 200) throw new Error(`${method} ${url} served an unauthenticated 200`);
      }
    }
    await h.close();
  });

  it('never returns a tenant secret or its hash', async () => {
    const h = await harness();
    await h.post('/v1/subjects/u1/grants', { credits: 10 });
    for (const url of ['/v1/subjects/u1', '/v1/metrics/margin', '/v1/rules', '/v1/register/export']) {
      const res = await h.get(url);
      expect(res.text, url).not.toMatch(/sk_(live|test)_|secret_key_hash|whsec_/);
    }
    await h.close();
  });

  it('keeps one tenant out of another tenant\'s ledger', async () => {
    const h = await harness();
    await h.post('/v1/subjects/shared_id/grants', { credits: 500 });

    // A second tenant, with its own key, asking for the same subject id.
    const other = 'T1111111111111111111111111';
    const { sha256Hex } = await import('@tegata/core');
    h.store.createTenant({
      tenant_id: other, name: 'other', secret_key_hash: sha256Hex('sk_other'),
      credit_unit_micro_usd: 20_000, degraded_mode: 'allow', max_overdraft_credits: 0,
      cost_table_pin: null, webhook_url: null, webhook_secret: null, low_balance_pct: 20,
    });
    const res = await h.app.inject({
      method: 'GET', url: '/v1/subjects/shared_id',
      headers: { authorization: 'Bearer sk_other' },
    });
    expect(res.statusCode).toBe(404);

    const exported = await h.app.inject({
      method: 'GET', url: '/v1/register/export', headers: { authorization: 'Bearer sk_other' },
    });
    expect(exported.body).not.toContain('shared_id');
    await h.close();
  });
});
