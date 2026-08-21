import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  deriveBalancesSelfContained, isZeroDeltaKind, LedgerError, sealEntry, verifyChain, ZERO_HASH,
} from './ledger.js';
import type { RegisterEntry, UnsealedEntry } from './types.js';

const base = (over: Partial<UnsealedEntry> = {}): UnsealedEntry => ({
  subject_id: 'user_1',
  at: '2026-08-21T00:00:00.000Z',
  kind: 'grant',
  delta_amount: 100,
  delta_cost_micro_usd: 0,
  meta: {},
  ...over,
});

function chain(entries: UnsealedEntry[]): RegisterEntry[] {
  const out: RegisterEntry[] = [];
  let seq = 0;
  let prev = ZERO_HASH;
  for (const e of entries) {
    const sealed = sealEntry(e, seq, prev);
    out.push(sealed);
    seq = sealed.seq;
    prev = sealed.hash;
  }
  return out;
}

describe('ledger convention', () => {
  it('forces holds to carry delta 0 - a reservation is not a movement of funds', () => {
    for (const kind of ['issue', 'release', 'dishonor', 'event'] as const) {
      expect(isZeroDeltaKind(kind)).toBe(true);
      expect(() => sealEntry(
        base({ kind, delta_amount: -5, authorization_id: 'A', meta: { face_value: 5, event: 'x' } }),
        0, ZERO_HASH,
      )).toThrow(LedgerError);
    }
  });

  it('requires a reservation to record its face value and its authorization', () => {
    expect(() => sealEntry(base({ kind: 'issue', delta_amount: 0, meta: {} }), 0, ZERO_HASH))
      .toThrow(/authorization/);
    expect(() => sealEntry(base({ kind: 'issue', delta_amount: 0, authorization_id: 'A', meta: {} }), 0, ZERO_HASH))
      .toThrow(/face_value/);
  });

  it('requires an adjustment to say what it corrects, and an event to name itself', () => {
    expect(() => sealEntry(base({ kind: 'adjust', delta_amount: -1, meta: {} }), 0, ZERO_HASH)).toThrow(/corrects/);
    expect(() => sealEntry(base({ kind: 'event', delta_amount: 0, meta: {} }), 0, ZERO_HASH)).toThrow(/meta.event/);
  });

  it('rejects a grant that does not grant and a capture that pays out', () => {
    expect(() => sealEntry(base({ kind: 'grant', delta_amount: 0 }), 0, ZERO_HASH)).toThrow(/positive/);
    expect(() => sealEntry(base({ kind: 'capture', delta_amount: 5, authorization_id: 'A' }), 0, ZERO_HASH))
      .toThrow(/increase the balance/);
  });

  it('rejects non-integer amounts at the boundary', () => {
    expect(() => sealEntry(base({ delta_amount: 1.5 }), 0, ZERO_HASH)).toThrow(/safe integer/);
    expect(() => sealEntry(base({ delta_cost_micro_usd: 0.5 }), 0, ZERO_HASH)).toThrow(/safe integer/);
  });
});

describe('chain integrity', () => {
  const entries = chain([
    base({ kind: 'grant', delta_amount: 1000, entitlement_id: 'E1', meta: { source: 'subscription' } }),
    base({ kind: 'issue', delta_amount: 0, authorization_id: 'A1', meta: { face_value: 47 } }),
    base({ kind: 'capture', delta_amount: -31, delta_cost_micro_usd: 620000, authorization_id: 'A1', meta: {} }),
  ]);

  it('starts from the genesis hash and links each entry to the last', () => {
    expect(entries[0]!.prev_hash).toBe(ZERO_HASH);
    expect(entries[1]!.prev_hash).toBe(entries[0]!.hash);
    expect(entries[2]!.seq).toBe(3);
    expect(verifyChain(entries)).toEqual({ ok: true });
  });

  it('detects a modified amount', () => {
    const tampered = entries.map((e, i) => (i === 2 ? { ...e, delta_amount: -1 } : e));
    expect(verifyChain(tampered)).toMatchObject({ ok: false, seq: 3 });
  });

  it('detects a deleted entry', () => {
    expect(verifyChain([entries[0]!, entries[2]!])).toMatchObject({ ok: false });
  });

  it('detects a reordered chain', () => {
    expect(verifyChain([entries[1]!, entries[0]!, entries[2]!])).toMatchObject({ ok: false });
  });

  it('accepts the published test vector unchanged, and rejects it when altered', () => {
    const lines = readFileSync('spec/examples/register.jsonl', 'utf8').trim().split('\n');
    const vector = lines.map((l) => JSON.parse(l) as RegisterEntry);
    expect(verifyChain(vector)).toEqual({ ok: true });
    const altered = vector.map((e, i) => (i === 2 ? { ...e, delta_amount: e.delta_amount - 1 } : e));
    expect(verifyChain(altered)).toMatchObject({ ok: false });
  });

  it('derives balance, reserved and available without double counting the hold', () => {
    const withOpenHold = chain([
      base({ kind: 'grant', delta_amount: 1000 }),
      base({ kind: 'issue', delta_amount: 0, authorization_id: 'A1', meta: { face_value: 47 } }),
    ]);
    expect(deriveBalancesSelfContained(withOpenHold)).toEqual({ balance: 1000, reserved: 47, available: 953 });
    expect(deriveBalancesSelfContained(entries)).toEqual({ balance: 969, reserved: 0, available: 969 });
  });

  it('releases a reservation without moving the balance', () => {
    const released = chain([
      base({ kind: 'grant', delta_amount: 500 }),
      base({ kind: 'issue', delta_amount: 0, authorization_id: 'A9', meta: { face_value: 180 } }),
      base({ kind: 'release', delta_amount: 0, authorization_id: 'A9', meta: { face_value: 180, reason: 'cancelled' } }),
    ]);
    expect(deriveBalancesSelfContained(released)).toEqual({ balance: 500, reserved: 0, available: 500 });
  });
});
