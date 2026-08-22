import { describe, expect, it } from 'vitest';
import { csvCell, csvDocument } from './csv.js';

describe('escaping a cell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('founder@example.com')).toBe('founder@example.com');
    expect(csvCell('site')).toBe('site');
    expect(csvCell('')).toBe('');
  });

  it('quotes what RFC 4180 says to quote', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  /**
   * The one that matters. `source` and `locale` come from a public form, and the file is
   * opened by the person holding the export key — the formula would run as them.
   */
  it('refuses to hand a spreadsheet a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('=HYPERLINK("http://evil.example","click")'))
      .toBe('"\'=HYPERLINK(""http://evil.example"",""click"")"');
    expect(csvCell('+41 79 000 0000')).toBe("'+41 79 000 0000");
    expect(csvCell('-3')).toBe("'-3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1+1')).toBe('"\'\t=1+1"');
  });

  it('and does so for an address that starts like one', () => {
    // Valid under our own shape check, so this reaches the file.
    expect(csvCell('-founder@example.com')).toBe("'-founder@example.com");
    expect(csvCell('+tag@example.com')).toBe("'+tag@example.com");
  });

  it('only at the start, because that is where a formula begins', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('one-two')).toBe('one-two');
  });
});

describe('a whole document', () => {
  it('is CRLF separated and ends with a newline', () => {
    const out = csvDocument(['id', 'email'], [['1', 'a@b.co'], ['2', '=evil()']]);
    expect(out).toBe('id,email\r\n1,a@b.co\r\n2,\'=evil()\r\n');
  });
});
