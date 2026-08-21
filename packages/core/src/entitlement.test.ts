import { describe, expect, it } from 'vitest';
import { consume, consumptionOrder, expiredEntitlements, overdraftRepayment, refreshOutcome, stackRemaining } from './entitlement.js';
import type { Entitlement } from './types.js';

const ent = (over: Partial<Entitlement> & { entitlement_id: string }): Entitlement => ({
  subject_id: 'user_1', source: 'grant', credits_granted: 100, credits_remaining: 100,
  effective_from: '2026-08-01T00:00:00.000Z', expires_at: null, refresh_policy: 'reset',
  rollover_cap_credits: null, priority: 100, status: 'active', amount_micro_usd: 0,
  source_ref: null, created_at: '2026-08-01T00:00:00.000Z', ...over,
});

describe('consumption order', () => {
  it('spends lower priority first', () => {
    const a = ent({ entitlement_id: 'A', priority: 10 });
    const b = ent({ entitlement_id: 'B', priority: 20 });
    expect([b, a].sort(consumptionOrder).map((e) => e.entitlement_id)).toEqual(['A', 'B']);
  });

  it('within a priority, spends the grant that expires soonest', () => {
    const soon = ent({ entitlement_id: 'SOON', expires_at: '2026-09-01T00:00:00.000Z' });
    const later = ent({ entitlement_id: 'LATER', expires_at: '2026-12-01T00:00:00.000Z' });
    const never = ent({ entitlement_id: 'NEVER', expires_at: null });
    expect([never, later, soon].sort(consumptionOrder).map((e) => e.entitlement_id))
      .toEqual(['SOON', 'LATER', 'NEVER']);
  });

  it('is total, so a replay consumes in the same order', () => {
    const a = ent({ entitlement_id: 'A' });
    const b = ent({ entitlement_id: 'B' });
    expect(consumptionOrder(a, b)).toBeLessThan(0);
    expect(consumptionOrder(b, a)).toBeGreaterThan(0);
    expect(consumptionOrder(a, a)).toBe(0);
  });
});

describe('drawing from the stack', () => {
  const stack = [
    ent({ entitlement_id: 'SUB', priority: 10, credits_remaining: 30 }),
    ent({ entitlement_id: 'TOP', priority: 20, credits_remaining: 50 }),
  ];

  it('drains in order and reports what each grant gave up', () => {
    expect(consume(stack, 45)).toEqual({
      consumptions: [{ entitlement_id: 'SUB', credits: 30 }, { entitlement_id: 'TOP', credits: 15 }],
      shortfall: 0,
    });
  });

  it('reports a shortfall rather than silently dropping it', () => {
    const { consumptions, shortfall } = consume(stack, 200);
    expect(shortfall).toBe(120);
    expect(consumptions.reduce((a, c) => a + c.credits, 0)).toBe(80);
  });

  it('ignores revoked and exhausted grants', () => {
    const mixed = [
      ent({ entitlement_id: 'DEAD', status: 'revoked', credits_remaining: 999 }),
      ent({ entitlement_id: 'EMPTY', credits_remaining: 0 }),
      ent({ entitlement_id: 'LIVE', credits_remaining: 10 }),
    ];
    expect(consume(mixed, 10).consumptions).toEqual([{ entitlement_id: 'LIVE', credits: 10 }]);
    expect(stackRemaining(mixed)).toBe(10);
  });

  it('rejects a non-integer draw at the boundary', () => {
    expect(() => consume(stack, 1.5)).toThrow(/safe integer/);
    expect(() => consume(stack, -1)).toThrow(/safe integer/);
  });
});

describe('overdraft repayment', () => {
  it('takes nothing when the subject is solvent', () => {
    expect(overdraftRepayment(500, 100)).toBe(0);
    expect(overdraftRepayment(0, 100)).toBe(0);
  });

  it('repays the debt before crediting the rest', () => {
    expect(overdraftRepayment(-30, 100)).toBe(30);
  });

  it('cannot repay more than it grants', () => {
    expect(overdraftRepayment(-500, 100)).toBe(100);
  });
});

describe('refresh', () => {
  const previous = ent({ entitlement_id: 'P', credits_remaining: 400 });

  it('reset lapses everything unused', () => {
    expect(refreshOutcome(previous, 'reset', null)).toEqual({ carry: 0, expire: 400 });
  });

  it('rollover carries everything', () => {
    expect(refreshOutcome(previous, 'rollover', null)).toEqual({ carry: 400, expire: 0 });
  });

  it('rollover_capped carries up to the cap and lapses the rest', () => {
    expect(refreshOutcome(previous, 'rollover_capped', 250)).toEqual({ carry: 250, expire: 150 });
    expect(refreshOutcome(previous, 'rollover_capped', 900)).toEqual({ carry: 400, expire: 0 });
  });
});

describe('expiry', () => {
  it('selects grants whose maturity has passed, in consumption order', () => {
    const stack = [
      ent({ entitlement_id: 'GONE', expires_at: '2026-08-10T00:00:00.000Z' }),
      ent({ entitlement_id: 'ALIVE', expires_at: '2026-09-10T00:00:00.000Z' }),
      ent({ entitlement_id: 'FOREVER', expires_at: null }),
    ];
    expect(expiredEntitlements(stack, '2026-08-21T00:00:00.000Z').map((e) => e.entitlement_id))
      .toEqual(['GONE']);
  });
});
