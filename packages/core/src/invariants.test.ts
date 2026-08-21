import { describe, expect, it } from 'vitest';
import { SeededRng } from './clock.js';
import { consume, overdraftRepayment, stackRemaining } from './entitlement.js';
import { deriveBalancesSelfContained, sealEntry, verifyChain, ZERO_HASH } from './ledger.js';
import type { Entitlement, RegisterEntry, UnsealedEntry } from './types.js';

/**
 * The ledger invariants from docs/plan/credits-mvp.md §4.1, exercised against
 * randomised operation sequences. Not a fuzzer: the seed is fixed, so a failure
 * here reproduces exactly.
 */

interface World {
  entries: RegisterEntry[];
  stack: Entitlement[];
  open: Map<string, number>;      // authorization_id -> face_value
  seq: number;
  prev: string;
  t: number;
  ids: number;
}

const MAX_OVERDRAFT = 200;

function fresh(): World {
  return { entries: [], stack: [], open: new Map(), seq: 0, prev: ZERO_HASH, t: Date.parse('2026-08-01T00:00:00.000Z'), ids: 0 };
}

function append(w: World, e: UnsealedEntry): RegisterEntry {
  const sealed = sealEntry(e, w.seq, w.prev);
  w.entries.push(sealed);
  w.seq = sealed.seq;
  w.prev = sealed.hash;
  return sealed;
}

const nextId = (w: World, p: string): string => `${p}${(++w.ids).toString().padStart(6, '0')}`;
const iso = (w: World): string => new Date(w.t).toISOString();

function balanceOf(w: World): number {
  let b = 0;
  for (const e of w.entries) b += e.delta_amount;
  return b;
}

function reservedOf(w: World): number {
  let r = 0;
  for (const v of w.open.values()) r += v;
  return r;
}

function grant(w: World, credits: number): void {
  const id = nextId(w, 'E');
  // A grant first repays whatever the balance is short, so the stack keeps describing
  // the money that is actually there.
  const repaid = overdraftRepayment(balanceOf(w), credits);
  w.stack.push({
    entitlement_id: id, subject_id: 'user_1', source: 'grant',
    credits_granted: credits, credits_remaining: credits - repaid,
    effective_from: iso(w), expires_at: null, refresh_policy: 'reset',
    rollover_cap_credits: null, priority: 100, status: 'active',
    amount_micro_usd: credits * 20000, source_ref: null, created_at: iso(w),
  });
  append(w, {
    subject_id: 'user_1', at: iso(w), kind: 'grant', delta_amount: credits,
    delta_cost_micro_usd: 0, entitlement_id: id, meta: { source: 'grant' },
  });
}

function issue(w: World, faceValue: number): string | null {
  const available = balanceOf(w) - reservedOf(w);
  const id = nextId(w, 'A');
  if (available < faceValue) {
    append(w, {
      subject_id: 'user_1', at: iso(w), kind: 'dishonor', delta_amount: 0,
      delta_cost_micro_usd: 0, meta: { reason: 'insufficient_balance', required: faceValue, available },
    });
    return null;
  }
  append(w, {
    subject_id: 'user_1', at: iso(w), kind: 'issue', delta_amount: 0,
    delta_cost_micro_usd: 0, authorization_id: id, meta: { face_value: faceValue },
  });
  w.open.set(id, faceValue);
  return id;
}

function capture(w: World, id: string, settled: number): void {
  const face = w.open.get(id);
  if (face === undefined) return;
  w.open.delete(id);
  const { consumptions, shortfall } = consume(w.stack, settled);
  for (const c of consumptions) {
    const ent = w.stack.find((e) => e.entitlement_id === c.entitlement_id)!;
    ent.credits_remaining -= c.credits;
  }
  void shortfall;                                   // the balance absorbs it as an overdraft
  append(w, {
    subject_id: 'user_1', at: iso(w), kind: 'capture', delta_amount: -settled,
    delta_cost_micro_usd: settled * 20000, authorization_id: id, meta: { face_value: face },
  });
}

function release(w: World, id: string): void {
  const face = w.open.get(id);
  if (face === undefined) return;
  w.open.delete(id);
  append(w, {
    subject_id: 'user_1', at: iso(w), kind: 'release', delta_amount: 0,
    delta_cost_micro_usd: 0, authorization_id: id, meta: { face_value: face, reason: 'released' },
  });
}

function checkInvariants(w: World, label: string): void {
  const derived = deriveBalancesSelfContained(w.entries);

  // INV-1 / INV-2 / INV-3
  expect(derived.balance, `${label} INV-1 balance`).toBe(balanceOf(w));
  expect(derived.reserved, `${label} INV-2 reserved`).toBe(reservedOf(w));
  expect(derived.available, `${label} INV-3 available`).toBe(derived.balance - derived.reserved);

  // INV-4 / INV-5
  w.entries.forEach((e, i) => expect(e.seq, `${label} INV-4 seq`).toBe(i + 1));
  expect(verifyChain(w.entries), `${label} INV-5 chain`).toEqual({ ok: true });

  // INV-6
  for (const e of w.entries) {
    if (e.kind === 'issue' || e.kind === 'release' || e.kind === 'dishonor' || e.kind === 'event') {
      expect(e.delta_amount, `${label} INV-6 ${e.kind}@${e.seq}`).toBe(0);
    }
  }

  // INV-7
  expect(derived.balance, `${label} INV-7 overdraft floor`).toBeGreaterThanOrEqual(-MAX_OVERDRAFT);

  // INV-8: the stack describes exactly the money that is there. Solvent, it equals the
  // balance; overdrawn, it is empty and the debt sits on the balance alone.
  expect(stackRemaining(w.stack), `${label} INV-8 stack vs balance`)
    .toBe(Math.max(0, derived.balance));
}

describe('ledger invariants under randomised operation sequences', () => {
  it('holds across 1,000 sequences of grants, issues, captures and releases', () => {
    const rng = new SeededRng('tegata-inv-1');
    const pick = (n: number): number => Math.floor(rng.next() * n);

    for (let run = 0; run < 1000; run++) {
      const w = fresh();
      grant(w, 100 + pick(900));
      const live: string[] = [];

      const steps = 5 + pick(20);
      for (let s = 0; s < steps; s++) {
        w.t += 1000 + pick(60_000);
        switch (pick(5)) {
          case 0:
            grant(w, 1 + pick(500));
            break;
          case 1: {
            const id = issue(w, 1 + pick(120));
            if (id !== null) live.push(id);
            break;
          }
          case 2: {
            if (live.length === 0) break;
            const id = live.splice(pick(live.length), 1)[0]!;
            const face = w.open.get(id)!;
            // Settle anywhere from nothing to over the face value, but never past the
            // overdraft floor, which is what the server enforces.
            const room = balanceOf(w) + MAX_OVERDRAFT;
            const wanted = pick(Math.floor(face * 1.5) + 1);
            capture(w, id, Math.max(0, Math.min(wanted, room)));
            break;
          }
          case 3: {
            if (live.length === 0) break;
            release(w, live.splice(pick(live.length), 1)[0]!);
            break;
          }
          default:
            break;
        }
      }
      checkInvariants(w, `run ${run}`);
    }
  });

  it('reconstructs the same figures from the entries alone after every step', () => {
    const rng = new SeededRng('tegata-inv-2');
    const w = fresh();
    grant(w, 1000);
    const live: string[] = [];
    for (let s = 0; s < 400; s++) {
      w.t += 1000;
      const r = rng.next();
      if (r < 0.25) grant(w, 1 + Math.floor(rng.next() * 100));
      else if (r < 0.6) {
        const id = issue(w, 1 + Math.floor(rng.next() * 80));
        if (id !== null) live.push(id);
      } else if (live.length > 0) {
        const id = live.pop()!;
        if (r < 0.85) {
          const room = balanceOf(w) + MAX_OVERDRAFT;
          capture(w, id, Math.max(0, Math.min(Math.floor(rng.next() * 90), room)));
        } else release(w, id);
      }
      // Rebuilding from scratch must agree with the incremental view every single step.
      checkInvariants(w, `step ${s}`);
    }
    expect(w.entries.length).toBeGreaterThan(300);
  });

  it('is reproducible: the same seed produces the same chain head', () => {
    const build = (): string => {
      const rng = new SeededRng('tegata-repro');
      const w = fresh();
      grant(w, 500);
      for (let i = 0; i < 50; i++) {
        w.t += 1000;
        const id = issue(w, 1 + Math.floor(rng.next() * 40));
        if (id !== null && rng.next() < 0.7) capture(w, id, Math.floor(rng.next() * 30));
      }
      return w.prev;
    };
    expect(build()).toBe(build());
  });
});
