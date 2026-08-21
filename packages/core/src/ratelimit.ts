import type { Clock } from './clock.js';

/**
 * A token bucket per key. Deterministic: it refills from the injected clock, never
 * from wall time, so a rate limit is as testable as the ledger it protects (D-29).
 *
 * Buckets are held in memory, which is the honest scope of a single node. Distributing
 * the limiter is the same problem as distributing the writer, deferred with it (Q-03).
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until one token is available. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  /** Tokens, scaled by 1000 so refill is integer arithmetic. */
  milliTokens: number;
  lastMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: Clock,
    private readonly ratePerSecond: number,
    private readonly burst: number = ratePerSecond,
    /** Above this many idle buckets, the coldest are dropped rather than kept forever. */
    private readonly maxKeys = 100_000,
  ) {
    if (!Number.isSafeInteger(ratePerSecond) || ratePerSecond <= 0) {
      throw new TypeError(`rate must be a positive safe integer, got ${String(ratePerSecond)}`);
    }
  }

  take(key: string, cost = 1): RateLimitDecision {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest(now);
      bucket = { milliTokens: this.burst * 1000, lastMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.lastMs);
      bucket.milliTokens = Math.min(
        this.burst * 1000,
        bucket.milliTokens + elapsed * this.ratePerSecond,
      );
      bucket.lastMs = now;
    }

    const price = cost * 1000;
    if (bucket.milliTokens >= price) {
      bucket.milliTokens -= price;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const shortfall = price - bucket.milliTokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(shortfall / (this.ratePerSecond * 1000))),
    };
  }

  /** Drop the least recently used half, so eviction is amortised rather than per-insert. */
  private evictOldest(now: number): void {
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].lastMs - b[1].lastMs);
    for (let i = 0; i < Math.floor(entries.length / 2); i++) {
      this.buckets.delete(entries[i]![0]);
    }
    void now;
  }

  get size(): number { return this.buckets.size; }
  reset(): void { this.buckets.clear(); }
}
