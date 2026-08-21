import { describe, expect, it } from 'vitest';
import { canonicalEmail, normaliseEmail, redactEmail, MAX_EMAIL_LENGTH } from './email.js';

describe('normalising an address', () => {
  it('trims and lowercases', () => {
    expect(normaliseEmail('  Founder@Example.COM ')).toEqual({ ok: true, normalised: 'founder@example.com' });
  });

  it('accepts the shapes people actually have', () => {
    for (const e of [
      'a@b.co', 'first.last@example.com', 'user+tag@example.com',
      'dev@sub.domain.example.com', "o'brien@example.com", 'user_name@example-host.com',
    ]) expect(normaliseEmail(e).ok, e).toBe(true);
  });

  it('refuses what will never deliver', () => {
    for (const e of [
      '', '   ', 'no-at-sign', '@example.com', 'user@', 'user@localhost',
      'user@exa mple.com', 'a@b..com', 'a@-example.com', 'a@example-.com',
      'two@addresses.com,other@x.com', '<script>@x.com',
    ]) expect(normaliseEmail(e).ok, e).toBe(false);
  });

  it('refuses an address longer than a mailbox can be', () => {
    const long = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`;
    expect(normaliseEmail(long)).toMatchObject({ ok: false, reason: 'too_long' });
    // And it does not echo the oversized input back.
    expect(normaliseEmail(long).normalised).toBe('');
  });
});

describe('collapsing spellings of one mailbox', () => {
  it('drops dots and tags where the provider documents that it does', () => {
    expect(canonicalEmail('first.last+tegata@gmail.com')).toBe('firstlast@gmail.com');
    expect(canonicalEmail('first.last@googlemail.com')).toBe('firstlast@googlemail.com');
  });

  it('drops only the tag where dots are significant', () => {
    expect(canonicalEmail('first.last+x@outlook.com')).toBe('first.last@outlook.com');
    expect(canonicalEmail('a.b+c@icloud.com')).toBe('a.b@icloud.com');
  });

  it('leaves unknown domains alone, because guessing would merge two people', () => {
    expect(canonicalEmail('first.last+x@example.com')).toBe('first.last+x@example.com');
    expect(canonicalEmail('a.b@company.co.jp')).toBe('a.b@company.co.jp');
  });
});

describe('redaction', () => {
  it('shows enough to recognise your own address and no more', () => {
    expect(redactEmail('founder@example.com')).toBe('f******@example.com');
  });

  it('keeps only the first character, once there is enough left to hide', () => {
    for (const e of ['abc@y.co', 'averylonglocalpart@y.co']) {
      const local = e.split('@')[0] as string;
      const shown = redactEmail(e).split('@')[0] as string;
      expect(shown[0], e).toBe(local[0]);
      expect(shown.slice(1), e).toMatch(/^\*+$/);
      expect(shown.length, e).toBe(local.length);
    }
  });

  it('reveals nothing at all when the local part is too short to hide in', () => {
    // Showing the first character of a one-character mailbox is showing the mailbox,
    // and the star count would leak the length of a two-character one.
    expect(redactEmail('x@y.co')).toBe('***@y.co');
    expect(redactEmail('ab@y.co')).toBe('***@y.co');
    expect(redactEmail('x@y.co')).toBe(redactEmail('ab@y.co'));
  });

  it('does not fall apart on input that is not an address', () => {
    expect(redactEmail('@example.com')).toBe('***');
    expect(redactEmail('nonsense')).toBe('***');
  });
});
