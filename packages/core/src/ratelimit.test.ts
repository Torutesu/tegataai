import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';
import { RateLimiter } from './ratelimit.js';

describe('rate limiting', () => {
  it('allows a burst, then refuses until the bucket refills', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const rl = new RateLimiter(clock, 20);        // 20/s, burst 20

    for (let i = 0; i < 20; i++) expect(rl.take('u1').allowed, `call ${i}`).toBe(true);
    const refused = rl.take('u1');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);

    clock.advance(50);                             // one token at 20/s
    expect(rl.take('u1').allowed).toBe(true);
    expect(rl.take('u1').allowed).toBe(false);
  });

  it('refills over time and never past the burst ceiling', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const rl = new RateLimiter(clock, 10);
    for (let i = 0; i < 10; i++) rl.take('u1');
    clock.advance(60_000);                         // an idle minute
    let allowed = 0;
    for (let i = 0; i < 50; i++) if (rl.take('u1').allowed) allowed++;
    expect(allowed).toBe(10);                      // the ceiling, not a minute's worth
  });

  it('keeps one subject out of another subject\'s budget', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const rl = new RateLimiter(clock, 2);
    expect(rl.take('u1').allowed).toBe(true);
    expect(rl.take('u1').allowed).toBe(true);
    expect(rl.take('u1').allowed).toBe(false);
    expect(rl.take('u2').allowed).toBe(true);      // untouched
  });

  it('reports a retry-after that is actually long enough', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const rl = new RateLimiter(clock, 1);
    rl.take('u1');
    const d = rl.take('u1');
    expect(d.allowed).toBe(false);
    clock.advance(d.retryAfterSeconds * 1000);
    expect(rl.take('u1').allowed).toBe(true);
  });

  it('is deterministic: the same clock and sequence give the same answers', () => {
    const run = (): boolean[] => {
      const clock = new FixedClock('2026-08-21T00:00:00.000Z');
      const rl = new RateLimiter(clock, 5);
      const out: boolean[] = [];
      for (let i = 0; i < 20; i++) { out.push(rl.take('u1').allowed); clock.advance(80); }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('sheds cold buckets instead of growing without bound', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    const rl = new RateLimiter(clock, 10, 10, 100);
    for (let i = 0; i < 400; i++) { rl.take(`u${i}`); clock.advance(1); }
    expect(rl.size).toBeLessThanOrEqual(100);
    // The most recent caller still has its bucket.
    expect(rl.take('u399').allowed).toBe(true);
  });

  it('refuses a nonsense configuration rather than limiting nothing', () => {
    const clock = new FixedClock('2026-08-21T00:00:00.000Z');
    expect(() => new RateLimiter(clock, 0)).toThrow();
    expect(() => new RateLimiter(clock, 1.5)).toThrow();
  });
});
