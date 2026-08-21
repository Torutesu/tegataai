import { describe, expect, it } from 'vitest';
import { evaluate, matches, parseWindowMs, type Policy, type PolicyInput } from './policy.js';
import { canTransition, clampMaturitySeconds, hasMatured, isOpen, isTerminal, MAX_MATURITY_SECONDS } from './authorization.js';
import { SeededRng, FixedClock, hashSeed } from './clock.js';
import { UlidFactory, ULID_PATTERN } from './ulid.js';

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  action: 'chat.completion', faceValue: 47, available: 1000,
  periodSettled: 0, aggregateSettled: 0, ...over,
});

describe('policy evaluation', () => {
  const p: Policy = {
    policy_id: 'consumer-default', version: 1,
    limits: { per_action: { max: 400 }, per_period: { window: 'P1D', max: 3000 } },
    scope: { actions: { allow: ['chat.completion', 'image.generate'] } },
  };

  it('allows what every clause permits', () => {
    expect(evaluate([p], input())).toEqual({ allowed: true });
  });

  it('names the clause that refused, so the holder knows which limit to raise', () => {
    const d = evaluate([p], input({ faceValue: 500 }));
    expect(d).toMatchObject({
      allowed: false, reason: 'policy_denied',
      rule: { policy_id: 'consumer-default', version: 1, clause: 'limits.per_action' },
    });
    if (!d.allowed) expect(d.rule.detail).toEqual({ max: 400, requested: 500 });
  });

  it('treats a period ceiling as exhausted budget, not a blanket denial', () => {
    const d = evaluate([p], input({ periodSettled: 2990, faceValue: 20 }));
    expect(d).toMatchObject({ allowed: false, reason: 'budget_exhausted_period' });
  });

  it('refuses an action outside the allow list', () => {
    expect(evaluate([p], input({ action: 'video.generate' })))
      .toMatchObject({ allowed: false, rule: { clause: 'scope.actions.allow' } });
  });

  it('treats an empty allow list as allowing nothing', () => {
    const closed: Policy = { policy_id: 'x', version: 1, scope: { actions: { allow: [] } } };
    expect(evaluate([closed], input())).toMatchObject({ allowed: false });
  });

  it('evaluates deny before allow, and deny is absolute', () => {
    const both: Policy = {
      policy_id: 'x', version: 1,
      scope: { actions: { allow: ['chat.completion'], deny: ['chat.completion'] } },
    };
    expect(evaluate([both], input())).toMatchObject({ allowed: false, rule: { clause: 'scope.actions.deny' } });
  });

  it('composes by intersection: the most restrictive policy wins', () => {
    const loose: Policy = { policy_id: 'org', version: 1, limits: { per_action: { max: 1000 } } };
    const tight: Policy = { policy_id: 'team', version: 2, limits: { per_action: { max: 10 } } };
    const d = evaluate([loose, tight], input({ faceValue: 50 }));
    expect(d).toMatchObject({ allowed: false, rule: { policy_id: 'team', version: 2 } });
  });

  it('applies a lifetime ceiling', () => {
    const capped: Policy = { policy_id: 'x', version: 1, limits: { aggregate: { max: 100 } } };
    expect(evaluate([capped], input({ aggregateSettled: 90, faceValue: 20 })))
      .toMatchObject({ allowed: false, rule: { clause: 'limits.aggregate' } });
  });

  it('allows when no policy is configured at all', () => {
    expect(evaluate([], input({ faceValue: 999_999 }))).toEqual({ allowed: true });
  });
});

describe('glob matching', () => {
  it('matches exactly, by prefix, and wholesale', () => {
    expect(matches(['chat.completion'], 'chat.completion')).toBe(true);
    expect(matches(['chat.'], 'chat.completion')).toBe(false);
    expect(matches(['chat.*'], 'chat.completion')).toBe(true);
    expect(matches(['*'], 'anything')).toBe(true);
    expect(matches([], 'anything')).toBe(false);
  });
});

describe('window durations', () => {
  it('accepts days, hours and minutes', () => {
    expect(parseWindowMs('P1D')).toBe(86_400_000);
    expect(parseWindowMs('PT6H')).toBe(21_600_000);
    expect(parseWindowMs('PT30M')).toBe(1_800_000);
    expect(parseWindowMs('P1DT12H')).toBe(129_600_000);
  });

  it('rejects the empty designators the schema also rejects', () => {
    for (const bad of ['P', 'PT', 'P1DT', '1D', 'P0D']) {
      expect(() => parseWindowMs(bad), bad).toThrow();
    }
  });
});

describe('authorization state machine', () => {
  it('lets an open hold settle, release, or lapse', () => {
    expect(canTransition('issued', 'captured')).toBe(true);
    expect(canTransition('issued', 'released')).toBe(true);
    expect(canTransition('issued', 'expired')).toBe(true);
  });

  it('never lets an issued authorization become dishonored - the action was already permitted', () => {
    expect(canTransition('issued', 'dishonored')).toBe(false);
  });

  it('treats every settled state as terminal', () => {
    for (const s of ['captured', 'released', 'expired', 'dishonored'] as const) {
      expect(isTerminal(s), s).toBe(true);
      expect(isOpen(s), s).toBe(false);
    }
    expect(isOpen('issued')).toBe(true);
  });

  it('clamps maturity to the specified ceiling', () => {
    expect(clampMaturitySeconds(undefined)).toBe(300);
    expect(clampMaturitySeconds(60)).toBe(60);
    expect(clampMaturitySeconds(99_999)).toBe(MAX_MATURITY_SECONDS);
    expect(() => clampMaturitySeconds(0)).toThrow();
    expect(() => clampMaturitySeconds(1.5)).toThrow();
  });

  it('compares maturity as ISO strings, which order lexically', () => {
    expect(hasMatured('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:01.000Z')).toBe(true);
    expect(hasMatured('2026-08-21T00:00:00.000Z', '2026-08-20T23:59:59.999Z')).toBe(false);
  });
});

describe('injected time and randomness', () => {
  it('advances only when told to', () => {
    const c = new FixedClock('2026-08-21T00:00:00.000Z');
    expect(c.iso()).toBe('2026-08-21T00:00:00.000Z');
    c.advance(1_500);
    expect(c.iso()).toBe('2026-08-21T00:00:01.500Z');
  });

  it('replays identically from the same seed, and differs across seeds', () => {
    const take = (seed: string): number[] => {
      const r = new SeededRng(seed);
      return Array.from({ length: 5 }, () => r.next());
    };
    expect(take('a')).toEqual(take('a'));
    expect(take('a')).not.toEqual(take('b'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });

  it('stays inside the unit interval', () => {
    const r = new SeededRng(1);
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('ULID', () => {
  it('matches the format the schemas require', () => {
    const f = new UlidFactory(() => 0.5);
    expect(f.generate(Date.parse('2026-08-21T00:00:00.000Z'))).toMatch(ULID_PATTERN);
  });

  it('sorts by creation order, including within a single millisecond', () => {
    const f = new UlidFactory(() => 0.5);
    const t = Date.parse('2026-08-21T00:00:00.000Z');
    const ids = [f.generate(t), f.generate(t), f.generate(t), f.generate(t + 1)];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
  });

  it('refuses a nonsense timestamp rather than emitting a malformed id', () => {
    const f = new UlidFactory(() => 0.5);
    expect(() => f.generate(-1)).toThrow();
    expect(() => f.generate(1.5)).toThrow();
  });
});
