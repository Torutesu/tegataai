/**
 * Time and randomness are injected, never read ambiently (D-29). Without this the
 * ledger invariants cannot be tested: a replay has to produce the same bytes.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** RFC 3339 in UTC with millisecond precision — the register's `at` format. */
  iso(): string;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

export const toIso = (ms: number): string => new Date(ms).toISOString();

/**
 * The one adapter to real time. Everything else takes a Clock, so this must be chosen
 * explicitly at a composition root and can never be reached from ledger logic by
 * accident. The `purity-ok` markers are the reviewed exemption from the check in
 * scripts/check-purity.mjs — they should appear nowhere else.
 */
export const systemClock: Clock = {
  now: () => Date.now(), // purity-ok: the composition root's clock
  iso: () => toIso(Date.now()), // purity-ok: the composition root's clock
};

/** A clock the tests drive by hand. */
export class FixedClock implements Clock {
  private t: number;
  constructor(startIso: string | number) {
    this.t = typeof startIso === 'number' ? startIso : Date.parse(startIso);
  }
  now(): number { return this.t; }
  iso(): string { return toIso(this.t); }
  advance(ms: number): void { this.t += ms; }
  set(iso: string): void { this.t = Date.parse(iso); }
}

/** Deterministic PRNG (mulberry32) so holdout assignment is reproducible. */
export class SeededRng implements Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
