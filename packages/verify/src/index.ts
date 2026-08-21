import { canonicalize, sha256Hex, ZERO_HASH, type JsonObject } from '@tegata/core';

export interface VerifyIssue { line: number; subject_id?: string; seq?: number; reason: string; }

export interface VerifyReport {
  ok: boolean;
  entries: number;
  subjects: number;
  issues: VerifyIssue[];
  balances: Record<string, { balance: number; reserved: number; available: number }>;
  manifest?: JsonObject;
  manifestChecked: boolean;
}

/**
 * Verify an exported register offline. It needs nothing but the file: the hash is
 * defined over the entry minus its hash field, with prev_hash inside, so a holder can
 * check our arithmetic without asking our permission (spec/register.md §5–6).
 */
export function verifyExport(jsonl: string): VerifyReport {
  const issues: VerifyIssue[] = [];
  const heads = new Map<string, { seq: number; hash: string }>();
  const balances: Record<string, { balance: number; reserved: number; available: number }> = {};
  const open = new Map<string, Map<string, number>>();
  let entries = 0;
  let manifest: JsonObject | undefined;

  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (raw.trim() === '') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      issues.push({ line: i + 1, reason: 'not valid JSON' });
      continue;
    }
    if (parsed.manifest === true) { manifest = parsed as JsonObject; continue; }

    const subject = String(parsed.subject_id ?? '');
    const seq = Number(parsed.seq);
    const hash = String(parsed.hash ?? '');
    const prevHash = String(parsed.prev_hash ?? '');
    const head = heads.get(subject);

    if (seq !== (head?.seq ?? 0) + 1) {
      issues.push({ line: i + 1, subject_id: subject, seq, reason: `sequence gap: expected ${(head?.seq ?? 0) + 1}` });
    }
    if (prevHash !== (head?.hash ?? ZERO_HASH)) {
      issues.push({ line: i + 1, subject_id: subject, seq, reason: 'prev_hash does not match the preceding entry' });
    }
    const { hash: _drop, ...body } = parsed;
    void _drop;
    let computed: string;
    try {
      computed = sha256Hex(canonicalize(body as JsonObject));
    } catch (e) {
      issues.push({ line: i + 1, subject_id: subject, seq, reason: `not canonicalisable: ${(e as Error).message}` });
      continue;
    }
    if (computed !== hash) {
      issues.push({ line: i + 1, subject_id: subject, seq, reason: 'hash does not match the entry contents' });
    }

    heads.set(subject, { seq, hash });
    entries++;

    const b = (balances[subject] ??= { balance: 0, reserved: 0, available: 0 });
    b.balance += Number(parsed.delta_amount ?? 0);
    const authId = parsed.authorization_id;
    if (typeof authId === 'string') {
      const held = open.get(subject) ?? new Map<string, number>();
      const kind = parsed.kind;
      if (kind === 'issue') {
        held.set(authId, Number((parsed.meta as JsonObject | undefined)?.face_value ?? 0));
      } else if (kind === 'capture' || kind === 'release' || kind === 'expire') {
        held.delete(authId);
      }
      open.set(subject, held);
    }
  }

  for (const [subject, b] of Object.entries(balances)) {
    let reserved = 0;
    for (const v of (open.get(subject) ?? new Map()).values()) reserved += v as number;
    b.reserved = reserved;
    b.available = b.balance - reserved;
  }

  let manifestChecked = false;
  if (manifest !== undefined) {
    manifestChecked = true;
    if (Number(manifest.entries) !== entries) {
      issues.push({ line: lines.length, reason: `manifest claims ${String(manifest.entries)} entries, found ${entries}` });
    }
    const roots = manifest.roots;
    if (Array.isArray(roots)) {
      for (const r of roots as { subject_id: string; seq: number; hash: string }[]) {
        const head = heads.get(r.subject_id);
        if (head === undefined) {
          issues.push({ line: lines.length, subject_id: r.subject_id, reason: 'manifest names a subject with no entries' });
        } else if (head.hash !== r.hash || head.seq !== r.seq) {
          issues.push({ line: lines.length, subject_id: r.subject_id, reason: 'chain head does not match the manifest root' });
        }
      }
    }
  }

  return { ok: issues.length === 0, entries, subjects: heads.size, issues, balances, manifest, manifestChecked };
}
