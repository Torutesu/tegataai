import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyExport } from './index.js';

describe('offline verification of an export', () => {
  const vector = readFileSync('spec/examples/register.jsonl', 'utf8');

  it('accepts the published test vector and reports its figures', () => {
    const r = verifyExport(vector);
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(6);
    expect(r.subjects).toBe(1);
    expect(r.balances.user_8f21).toEqual({ balance: 969, reserved: 0, available: 969 });
  });

  it('detects a single altered byte in an amount (AC-07)', () => {
    const lines = vector.trim().split('\n');
    const entry = JSON.parse(lines[2]!) as { delta_amount: number };
    entry.delta_amount -= 1;
    lines[2] = JSON.stringify(entry);
    const r = verifyExport(lines.join('\n'));
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ seq: 3, reason: expect.stringContaining('hash') });
  });

  it('detects a deleted entry as a sequence gap and a broken link', () => {
    const lines = vector.trim().split('\n');
    lines.splice(2, 1);
    const r = verifyExport(lines.join('\n'));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.reason.includes('sequence gap'))).toBe(true);
  });

  it('detects an inserted entry, even one copied from elsewhere in the chain', () => {
    const lines = vector.trim().split('\n');
    lines.splice(3, 0, lines[1]!);
    expect(verifyExport(lines.join('\n')).ok).toBe(false);
  });

  it('detects reordering', () => {
    const lines = vector.trim().split('\n');
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    expect(verifyExport(lines.join('\n')).ok).toBe(false);
  });

  it('detects a changed hash that was recomputed but not relinked', () => {
    const lines = vector.trim().split('\n');
    const e = JSON.parse(lines[1]!) as Record<string, unknown>;
    e.meta = { face_value: 999 };
    lines[1] = JSON.stringify(e);
    expect(verifyExport(lines.join('\n')).ok).toBe(false);
  });

  it('reports malformed lines rather than throwing', () => {
    const r = verifyExport(`${vector}\nnot json at all\n`);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.reason.includes('not valid JSON'))).toBe(true);
  });

  it('checks the manifest against what it actually read', () => {
    const good = `${vector.trim()}\n${JSON.stringify({
      manifest: true, subjects: 1, entries: 6,
      roots: [{ subject_id: 'user_8f21', seq: 6, hash: (JSON.parse(vector.trim().split('\n')[5]!) as { hash: string }).hash }],
    })}\n`;
    const r = verifyExport(good);
    expect(r.ok).toBe(true);
    expect(r.manifestChecked).toBe(true);

    const lying = `${vector.trim()}\n${JSON.stringify({ manifest: true, subjects: 1, entries: 99, roots: [] })}\n`;
    expect(verifyExport(lying).ok).toBe(false);
  });

  it('separates the held from the settled across several subjects', () => {
    const r = verifyExport(vector);
    expect(r.balances.user_8f21!.balance - r.balances.user_8f21!.reserved)
      .toBe(r.balances.user_8f21!.available);
  });
});
