import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from './jcs.js';

describe('JCS canonicalization', () => {
  it('orders object members and drops insignificant whitespace', () => {
    expect(canonicalize({ b: 1, a: 2 } as never)).toBe('{"a":2,"b":1}');
  });

  it('is stable regardless of construction order', () => {
    const a = canonicalize({ x: { q: 1, p: 2 }, y: [1, 2] } as never);
    const b = canonicalize({ y: [1, 2], x: { p: 2, q: 1 } } as never);
    expect(a).toBe(b);
  });

  it('refuses floats - a float in a ledger is a defect, not a value to serialise', () => {
    expect(() => canonicalize({ amount: 1.5 } as never)).toThrow(/safe integers/);
    expect(() => canonicalize({ amount: NaN } as never)).toThrow(/safe integers/);
    expect(() => canonicalize({ amount: Number.MAX_VALUE } as never)).toThrow(/safe integers/);
  });

  it('escapes quotes, backslashes and control characters', () => {
    expect(canonicalize({ s: 'a"b\\c\nd' } as never)).toBe('{"s":"a\\"b\\\\c\\nd"}');
    const ctrl = String.fromCharCode(1);
    expect(canonicalize({ s: ctrl } as never)).toBe('{"s":"\\u0001"}');
  });

  it('keeps non-ASCII literal, as JCS requires', () => {
    expect(canonicalize({ s: '手形' } as never)).toBe('{"s":"手形"}');
  });

  it('agrees with the digest the published spec verifier computes', () => {
    const body = { a: 1, kind: 'grant', meta: { source: 'subscription' } };
    expect(sha256Hex(canonicalize(body as never)))
      .toBe(sha256Hex('{"a":1,"kind":"grant","meta":{"source":"subscription"}}'));
  });

  it('omits undefined members rather than emitting null for them', () => {
    expect(canonicalize({ a: 1, b: undefined } as never)).toBe('{"a":1}');
  });
});
