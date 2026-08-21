const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32, per the ULID spec

/**
 * ULIDs, with time and randomness passed in (D-29). Monotonic within a millisecond
 * so ids generated in one transaction sort in creation order.
 */
export class UlidFactory {
  private lastTime = -1;
  private lastRandom: number[] = [];

  constructor(private readonly rand: () => number) {}

  generate(timeMs: number): string {
    if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
      throw new TypeError(`ulid: time must be a non-negative safe integer, got ${String(timeMs)}`);
    }
    if (timeMs === this.lastTime) {
      this.increment();
    } else {
      this.lastTime = timeMs;
      this.lastRandom = Array.from({ length: 16 }, () => Math.floor(this.rand() * 32));
    }
    return encodeTime(timeMs) + this.lastRandom.map((n) => ENCODING[n]).join('');
  }

  private increment(): void {
    for (let i = this.lastRandom.length - 1; i >= 0; i--) {
      const v = this.lastRandom[i] as number;
      if (v < 31) { this.lastRandom[i] = v + 1; return; }
      this.lastRandom[i] = 0;
    }
  }
}

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = (ENCODING[t % 32] as string) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
