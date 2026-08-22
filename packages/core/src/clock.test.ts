import { describe, expect, it } from 'vitest';
import { FixedClock, SeededRng, cryptoRng, systemClock, toIso } from './clock.js';
import { UlidFactory } from './ulid.js';

describe('the adapters at the composition root', () => {
  it('the system clock reads real time in the register format', () => {
    // Bounded rather than compared against Date.now(), because reaching for the wall
    // clock is the thing this package forbids — including here.
    const now = systemClock.now();
    expect(Number.isSafeInteger(now)).toBe(true);
    expect(now).toBeGreaterThan(Date.parse('2025-01-01T00:00:00.000Z'));
    expect(now).toBeLessThan(Date.parse('2100-01-01T00:00:00.000Z'));
    expect(systemClock.iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(systemClock.now()).toBeGreaterThanOrEqual(now);   // it moves forwards
  });

  /**
   * The point of this one is not that the numbers look random — it is that nobody
   * swaps it back for something reconstructable. Every id in the ledger is drawn from
   * whatever is injected here.
   */
  it('the production rng stays in the unit interval and does not repeat', () => {
    const draws = Array.from({ length: 10_000 }, () => cryptoRng.next());
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(draws).size).toBe(draws.length);
  });

  it('and unlike the seeded one, two runs of it do not agree', () => {
    const seeded = () => Array.from({ length: 8 }, (() => { const r = new SeededRng(7); return () => r.next(); })());
    expect(seeded()).toEqual(seeded());       // the tests depend on this
    const live = () => Array.from({ length: 8 }, () => cryptoRng.next());
    expect(live()).not.toEqual(live());       // and production must not have it
  });

  it('produces ULIDs that do not collide or share a random part', () => {
    const ulid = new UlidFactory(() => cryptoRng.next());
    // One millisecond apart, so the time prefix is equal and only the random part differs.
    const ids = Array.from({ length: 500 }, (_, i) => ulid.generate(1_700_000_000_000 + (i % 2)));
    expect(new Set(ids).size).toBe(ids.length);
    const tails = new Set(ids.map((id) => id.slice(10)));
    expect(tails.size).toBeGreaterThan(400);
  });
});

describe('the clock the tests drive', () => {
  it('moves only when told to', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const t = clock.now();
    expect(clock.now()).toBe(t);
    clock.advance(1_000);
    expect(clock.iso()).toBe('2026-08-21T00:00:01.000Z');
    expect(toIso(clock.now())).toBe(clock.iso());
  });
});
