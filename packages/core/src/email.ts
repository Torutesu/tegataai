/**
 * Email handling for the waitlist. Kept deliberately small: this is the only personal
 * data the system stores, it never touches the register (spec/register.md forbids it),
 * and everything here is a pure function so the rules are testable.
 */

/** A conservative shape check. Not RFC 5322 — that grammar accepts things no provider will. */
const SHAPE = /^[^\s@,;<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export const MAX_EMAIL_LENGTH = 254;   // RFC 5321 §4.5.3.1.3

export interface EmailCheck {
  ok: boolean;
  /** Lowercased and trimmed. The form actually stored. */
  normalised: string;
  reason?: 'empty' | 'too_long' | 'malformed';
}

export function normaliseEmail(raw: string): EmailCheck {
  const normalised = raw.trim().toLowerCase();
  if (normalised.length === 0) return { ok: false, normalised, reason: 'empty' };
  if (normalised.length > MAX_EMAIL_LENGTH) return { ok: false, normalised: '', reason: 'too_long' };
  if (!SHAPE.test(normalised)) return { ok: false, normalised, reason: 'malformed' };
  const at = normalised.lastIndexOf('@');
  const domain = normalised.slice(at + 1);
  if (domain.includes('..') || domain.startsWith('-') || domain.endsWith('-')) {
    return { ok: false, normalised, reason: 'malformed' };
  }
  return { ok: true, normalised };
}

/**
 * Gmail treats dots and +tags as noise, so two spellings of one mailbox would otherwise
 * become two signups. Applied only to domains that document the behaviour — guessing at
 * others would silently merge distinct people.
 */
const DOT_AND_PLUS_BLIND = new Set(['gmail.com', 'googlemail.com']);
const PLUS_BLIND = new Set(['outlook.com', 'hotmail.com', 'live.com', 'fastmail.com', 'icloud.com']);

export function canonicalEmail(normalised: string): string {
  const at = normalised.lastIndexOf('@');
  if (at < 0) return normalised;
  let local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);
  if (DOT_AND_PLUS_BLIND.has(domain) || PLUS_BLIND.has(domain)) {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
  }
  if (DOT_AND_PLUS_BLIND.has(domain)) local = local.split('.').join('');
  return `${local}@${domain}`;
}

/**
 * For logs and errors: enough to recognise your own address, not enough to harvest.
 *
 * The first character is revealed only when there is enough left to hide. For a local
 * part of one or two characters, showing the first would disclose half or all of it, so
 * those are starred out entirely and padded to a fixed width — otherwise the length of a
 * short mailbox leaks through the redaction that was supposed to conceal it.
 */
export function redactEmail(normalised: string): string {
  const at = normalised.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);
  if (local.length <= 2) return `***@${domain}`;
  return `${local.slice(0, 1)}${'*'.repeat(local.length - 1)}@${domain}`;
}
