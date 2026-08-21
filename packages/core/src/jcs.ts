import { createHash } from 'node:crypto';
import type { JsonValue } from './types.js';

/**
 * RFC 8785 (JCS) over the value set the register actually uses: objects, arrays,
 * strings, booleans, null, and integers. Floats are rejected rather than serialised,
 * because a float in a ledger is a defect, and a canonicaliser that quietly accepts
 * one would hide it (CLAUDE.md rule 1).
 */
export function canonicalize(value: JsonValue): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

function write(v: JsonValue, out: string[]): void {
  if (v === null) { out.push('null'); return; }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isSafeInteger(v)) {
        throw new TypeError(`canonicalize: only safe integers are allowed in the register, got ${String(v)}`);
      }
      out.push(String(v));
      return;
    case 'string':
      out.push(quote(v));
      return;
    default:
      break;
  }
  if (Array.isArray(v)) {
    out.push('[');
    v.forEach((item, i) => { if (i > 0) out.push(','); write(item, out); });
    out.push(']');
    return;
  }
  const obj = v as { [k: string]: JsonValue };
  // JCS orders members by their UTF-16 code units, which is what sort() does.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  out.push('{');
  keys.forEach((k, i) => {
    if (i > 0) out.push(',');
    out.push(quote(k), ':');
    write(obj[k] as JsonValue, out);
  });
  out.push('}');
}

const ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f',
  '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function quote(s: string): string {
  let r = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc !== undefined) { r += esc; continue; }
    const code = ch.codePointAt(0) as number;
    r += code < 0x20 ? '\\u' + code.toString(16).padStart(4, '0') : ch;
  }
  return r + '"';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The genesis link of every subject's chain. spec/register.md §5. */
export const ZERO_HASH = '0'.repeat(64);
