import { canonicalize, sha256Hex, ZERO_HASH } from './jcs.js';
import type {
  Balances, Credits, JsonObject, JsonValue, RegisterEntry, RegisterKind, UnsealedEntry,
} from './types.js';

/**
 * Kinds that must never move the balance. A reservation is a commitment, not a
 * movement of funds; an approval or a refusal is a fact, not a payment.
 * spec/register.md §3 — this is what keeps `available` from double-counting.
 */
const ZERO_DELTA_KINDS: ReadonlySet<RegisterKind> = new Set(['issue', 'release', 'dishonor', 'event']);

export function isZeroDeltaKind(kind: RegisterKind): boolean {
  return ZERO_DELTA_KINDS.has(kind);
}

/** Kinds that open or close a reservation, and so must name their authorization. */
const RESERVATION_KINDS: ReadonlySet<RegisterKind> = new Set(['issue', 'release']);

export class LedgerError extends Error {}

/**
 * Seal an entry into a subject's chain: assign the next sequence number, link it to
 * its predecessor, and hash it. The hash covers the whole entry minus the hash field,
 * with prev_hash inside — one definition, so an independent verifier needs no
 * special knowledge (spec/register.md §5).
 */
export function sealEntry(entry: UnsealedEntry, prevSeq: number, prevHash: string): RegisterEntry {
  assertEntry(entry);
  const seq = prevSeq + 1;
  const body: Record<string, JsonValue> = {
    seq,
    subject_id: entry.subject_id,
    at: entry.at,
    kind: entry.kind,
    delta_amount: entry.delta_amount,
    delta_cost_micro_usd: entry.delta_cost_micro_usd,
    meta: entry.meta,
    prev_hash: prevHash,
  };
  if (entry.authorization_id !== undefined) body.authorization_id = entry.authorization_id;
  if (entry.entitlement_id !== undefined) body.entitlement_id = entry.entitlement_id;
  if (entry.policy_ref !== undefined) {
    body.policy_ref = { policy_id: entry.policy_ref.policy_id, version: entry.policy_ref.version };
  }
  const hash = sha256Hex(canonicalize(body as JsonValue));
  return { ...(body as unknown as Omit<RegisterEntry, 'hash'>), hash };
}

export function assertEntry(entry: UnsealedEntry): void {
  if (!Number.isSafeInteger(entry.delta_amount)) {
    throw new LedgerError(`delta_amount must be a safe integer, got ${String(entry.delta_amount)}`);
  }
  if (!Number.isSafeInteger(entry.delta_cost_micro_usd)) {
    throw new LedgerError(`delta_cost_micro_usd must be a safe integer, got ${String(entry.delta_cost_micro_usd)}`);
  }
  if (isZeroDeltaKind(entry.kind) && entry.delta_amount !== 0) {
    throw new LedgerError(`kind '${entry.kind}' must carry delta_amount 0, got ${entry.delta_amount}`);
  }
  if (entry.kind === 'grant' && entry.delta_amount <= 0) {
    throw new LedgerError('grant must be positive');
  }
  if (entry.kind === 'capture' && entry.delta_amount > 0) {
    throw new LedgerError('capture must not increase the balance');
  }
  if (RESERVATION_KINDS.has(entry.kind)) {
    if (entry.authorization_id === undefined) {
      throw new LedgerError(`kind '${entry.kind}' must name its authorization`);
    }
    if (!Number.isSafeInteger(entry.meta.face_value as number)) {
      throw new LedgerError(`kind '${entry.kind}' must record meta.face_value`);
    }
  }
  if (entry.kind === 'capture' && entry.authorization_id === undefined) {
    // Every settlement names an authorization, including a direct one, which is created
    // already settled. An auditor following a capture must always find something.
    throw new LedgerError('capture must name its authorization');
  }
  if (entry.kind === 'adjust' && entry.meta.corrects === undefined) {
    throw new LedgerError('adjust must reference the entry it corrects in meta.corrects');
  }
  if (entry.kind === 'event' && entry.meta.event === undefined) {
    throw new LedgerError('event must name the occurrence in meta.event');
  }
}

/** Recompute a chain from scratch. The register is the only truth; this is how we check it. */
export function verifyChain(entries: readonly RegisterEntry[]): { ok: true } | { ok: false; seq: number; reason: string } {
  let prevHash = ZERO_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as RegisterEntry;
    if (e.seq !== i + 1) return { ok: false, seq: e.seq, reason: `sequence gap: expected ${i + 1}` };
    if (e.prev_hash !== prevHash) return { ok: false, seq: e.seq, reason: 'prev_hash does not match the preceding entry' };
    const { hash, ...rest } = e;
    const computed = sha256Hex(canonicalize(stripUndefined(rest) as unknown as JsonValue));
    if (computed !== hash) return { ok: false, seq: e.seq, reason: 'hash does not match the entry contents' };
    prevHash = hash;
  }
  return { ok: true };
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Derive the three figures from entries alone (spec/register.md §4).
 * `openAuthorizations` names the authorizations that have not reached a terminal
 * state — reservations only count while they are still open.
 */
export function deriveBalances(
  entries: readonly RegisterEntry[],
  openAuthorizations: ReadonlySet<string>,
): Balances {
  let balance = 0;
  let reserved = 0;
  for (const e of entries) {
    balance += e.delta_amount;
    if (e.kind === 'issue' && e.authorization_id !== undefined && openAuthorizations.has(e.authorization_id)) {
      reserved += e.meta.face_value as number;
    }
  }
  return { balance, reserved, available: balance - reserved };
}

/** The same derivation without external knowledge: a capture or release closes its issue. */
export function deriveBalancesSelfContained(entries: readonly RegisterEntry[]): Balances {
  const open = new Map<string, Credits>();
  let balance = 0;
  for (const e of entries) {
    balance += e.delta_amount;
    if (e.authorization_id === undefined) continue;
    if (e.kind === 'issue') open.set(e.authorization_id, e.meta.face_value as number);
    else if (e.kind === 'capture' || e.kind === 'release' || e.kind === 'expire') open.delete(e.authorization_id);
  }
  let reserved = 0;
  for (const v of open.values()) reserved += v;
  return { balance, reserved, available: balance - reserved };
}

export function entryToJson(e: RegisterEntry): JsonObject {
  const o: JsonObject = {
    seq: e.seq,
    subject_id: e.subject_id,
    at: e.at,
    kind: e.kind,
    delta_amount: e.delta_amount,
    delta_cost_micro_usd: e.delta_cost_micro_usd,
    meta: e.meta,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
  if (e.authorization_id !== undefined) o.authorization_id = e.authorization_id;
  if (e.entitlement_id !== undefined) o.entitlement_id = e.entitlement_id;
  if (e.policy_ref !== undefined) o.policy_ref = { ...e.policy_ref };
  return o;
}

export { ZERO_HASH };
