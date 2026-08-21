import { describe, expect, it, beforeEach } from 'vitest';
import { FixedClock, SeededRng, sha256Hex } from '@tegata/core';
import { Store } from './store.js';

const T = 'T0000000000000000000000000';

function newStore(): Store {
  const s = new Store({ clock: new FixedClock('2026-08-21T00:00:00.000Z'), rng: new SeededRng(7) });
  s.createTenant({
    tenant_id: T, name: 'test', secret_key_hash: sha256Hex('sk_test'),
    credit_unit_micro_usd: 20_000, degraded_mode: 'allow', max_overdraft_credits: 200,
    cost_table_pin: null, webhook_url: null, webhook_secret: null, low_balance_pct: 20,
  });
  return s;
}

describe('append-only enforcement', () => {
  let s: Store;
  beforeEach(() => { s = newStore(); s.ensureSubject(T, 'u1'); });

  it('refuses an UPDATE to the register at the storage layer, not by convention', () => {
    s.grant(T, 'u1', { source: 'grant', credits: 100 });
    expect(() => s.db.prepare('UPDATE register SET delta_amount = 999 WHERE seq = 1').run())
      .toThrow(/append-only/);
  });

  it('refuses a DELETE from the register', () => {
    s.grant(T, 'u1', { source: 'grant', credits: 100 });
    expect(() => s.db.prepare('DELETE FROM register WHERE seq = 1').run()).toThrow(/append-only/);
  });

  it('keeps the chain verifiable as entries accumulate', () => {
    s.grant(T, 'u1', { source: 'grant', credits: 100 });
    s.append(T, 'u1', { kind: 'issue', delta_amount: 0, authorization_id: 'A1', meta: { face_value: 20 } });
    s.append(T, 'u1', { kind: 'capture', delta_amount: -15, delta_cost_micro_usd: 300, authorization_id: 'A1', meta: {} });
    expect(s.verifySubjectChain(T, 'u1')).toEqual({ ok: true });
  });
});

describe('projection is a cache, the register is the truth', () => {
  it('agrees with a rebuild from the entries alone (INV-10)', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'subscription', credits: 1000 });
    s.append(T, 'u1', { kind: 'issue', delta_amount: 0, authorization_id: 'A1', meta: { face_value: 47 } });
    expect(s.balances(T, 'u1')).toEqual({ balance: 1000, reserved: 47, available: 953 });

    s.append(T, 'u1', { kind: 'capture', delta_amount: -31, authorization_id: 'A1', meta: {} });
    s.releaseReservation(T, 'u1', 47);
    const live = s.balances(T, 'u1');
    expect(live).toEqual({ balance: 969, reserved: 0, available: 969 });
    expect(s.rebuildProjection(T, 'u1')).toEqual(live);
  });

  it('a corrupted cache is corrected by the register, not the other way round', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 500 });
    s.db.prepare('UPDATE balance_projection SET balance = 999999').run();
    expect(s.balances(T, 'u1').balance).toBe(999999);
    expect(s.rebuildProjection(T, 'u1').balance).toBe(500);
  });
});

describe('idempotency', () => {
  it('lets exactly one of many concurrent replays proceed (AC-04)', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 10_000 });

    const hash = sha256Hex('body');
    let winners = 0;
    for (let i = 0; i < 100; i++) {
      // better-sqlite3 is synchronous, so this loop is the concurrency: each pass is
      // exactly what a parallel request would do at the same point in the sequence.
      const claimed = s.withSubject(() => {
        if (!s.claimIdempotent(T, 'same-key', hash)) return false;
        s.append(T, 'u1', { kind: 'capture', delta_amount: -5, authorization_id: `A${i}`, meta: {} });
        s.completeIdempotent(T, 'same-key', 200, { ok: true });
        return true;
      });
      if (claimed) winners++;
    }
    expect(winners).toBe(1);
    expect(s.balances(T, 'u1').balance).toBe(10_000 - 5);
  });

  it('replays return the stored response rather than recomputing', () => {
    const s = newStore();
    const hash = sha256Hex('body');
    expect(s.claimIdempotent(T, 'k', hash)).toBe(true);
    s.completeIdempotent(T, 'k', 201, { authorization_id: 'A1' });
    expect(s.lookupIdempotent(T, 'k', hash)).toEqual({ status: 201, body: { authorization_id: 'A1' } });
  });

  it('reports a conflict when the same key arrives with a different body', () => {
    const s = newStore();
    s.claimIdempotent(T, 'k', sha256Hex('one'));
    s.completeIdempotent(T, 'k', 200, {});
    expect(s.lookupIdempotent(T, 'k', sha256Hex('two'))).toBe('conflict');
  });

  it('purges by age so keys do not accumulate forever', () => {
    const s = newStore();
    s.claimIdempotent(T, 'old', sha256Hex('x'));
    expect(s.purgeIdempotency('2026-08-22T00:00:00.000Z')).toBe(1);
    expect(s.lookupIdempotent(T, 'old', sha256Hex('x'))).toBeUndefined();
  });
});

describe('concurrent issue against a thin balance (AC-05)', () => {
  it('authorises exactly one hold when only one is affordable', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 1 });

    let authorised = 0;
    for (let i = 0; i < 50; i++) {
      const ok = s.withSubject(() => {
        const { available } = s.balances(T, 'u1');
        if (available < 1) return false;
        s.append(T, 'u1', { kind: 'issue', delta_amount: 0, authorization_id: `A${i}`, meta: { face_value: 1 } });
        return true;
      });
      if (ok) authorised++;
    }
    expect(authorised).toBe(1);
    expect(s.balances(T, 'u1')).toEqual({ balance: 1, reserved: 1, available: 0 });
  });
});

describe('entitlement stack in storage', () => {
  it('draws in consumption order and records which grants paid', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'subscription', credits: 30, priority: 10 });
    s.grant(T, 'u1', { source: 'topup', credits: 50, priority: 20 });

    const shortfall = s.drawFromStack(T, 'u1', 'A1', 45);
    expect(shortfall).toBe(0);
    const rows = s.db.prepare(
      'SELECT entitlement_id, credits FROM consumption WHERE authorization_id = ? ORDER BY credits DESC',
    ).all('A1') as { entitlement_id: string; credits: number }[];
    expect(rows.map((r) => r.credits)).toEqual([30, 15]);
    const remaining = s.activeEntitlements(T, 'u1').reduce((a, e) => a + e.credits_remaining, 0);
    expect(remaining).toBe(35);
  });

  it('reports a shortfall when the stack cannot cover the draw', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 10 });
    expect(s.drawFromStack(T, 'u1', 'A1', 25)).toBe(15);
  });

  it('repays an overdraft out of the next grant', () => {
    const s = newStore();
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 10 });
    s.drawFromStack(T, 'u1', 'A1', 10);
    s.append(T, 'u1', { kind: 'capture', delta_amount: -40, authorization_id: 'A1', meta: {} });
    expect(s.balances(T, 'u1').balance).toBe(-30);

    const { entitlement } = s.grant(T, 'u1', { source: 'grant', credits: 100 });
    expect(entitlement.credits_remaining).toBe(70);
    expect(s.balances(T, 'u1').balance).toBe(70);
  });
});

describe('settlement windows', () => {
  it('totals only what settled inside the window', () => {
    const clock = new FixedClock('2026-08-01T00:00:00.000Z');
    const s = new Store({ clock, rng: new SeededRng(1) });
    s.createTenant({
      tenant_id: T, name: 't', secret_key_hash: sha256Hex('k'), credit_unit_micro_usd: 20_000,
      degraded_mode: 'allow', max_overdraft_credits: 200, cost_table_pin: null,
      webhook_url: null, webhook_secret: null, low_balance_pct: 20,
    });
    s.ensureSubject(T, 'u1');
    s.grant(T, 'u1', { source: 'grant', credits: 1000 });
    s.append(T, 'u1', { kind: 'capture', delta_amount: -10, authorization_id: 'A1', meta: {} });
    clock.advance(10 * 86_400_000);
    s.append(T, 'u1', { kind: 'capture', delta_amount: -25, authorization_id: 'A2', meta: {} });

    expect(s.settledLifetime(T, 'u1')).toBe(35);
    expect(s.settledSince(T, 'u1', '2026-08-05T00:00:00.000Z')).toBe(25);
  });
});

describe('the one place a column name is not a bound parameter', () => {
  it('writes the columns it knows and refuses anything else', () => {
    const s = newStore();
    s.updateTenant(T, { low_balance_pct: 35 });
    expect(s.getTenant(T)!.low_balance_pct).toBe(35);

    expect(() => s.updateTenant(T, { 'name = \'x\'; DROP TABLE register; --': 'y' } as never))
      .toThrow(/unknown column/);
    // The threat it exists for: the register is still there.
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'register'").get()).toBeDefined();
  });
});
