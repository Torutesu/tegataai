/**
 * Writing CSV that a person will open in a spreadsheet.
 *
 * Quoting is the easy half. The half that gets missed is that a spreadsheet does not
 * read a CSV as data: a cell beginning with `=`, `+`, `-` or `@` is a formula, and it
 * runs when the file is opened. The waitlist export is the exact shape of that problem —
 * `source` and `locale` arrive from an unauthenticated form on a public page, and the
 * file is opened by the one person who has the key to export it.
 *
 * So a value that would be read as a formula is prefixed with an apostrophe, which every
 * spreadsheet reads as "the rest of this is text". The stored value is untouched; this
 * is a property of the file, not of the record.
 */

/** Leading characters a spreadsheet treats as the start of a formula. Tab and CR count. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  // A tab needs no quoting in a comma-separated file, but it is quoted anyway: tools
  // that guess the delimiter guess differently, and a value that splits under one guess
  // and not the other is not worth the two bytes saved.
  return /["\n\r,\t]/.test(guarded) ? `"${guarded.split('"').join('""')}"` : guarded;
}

/** One row, already escaped and joined. Rows are joined with CRLF, as RFC 4180 asks. */
export const csvRow = (cells: readonly string[]): string => cells.map(csvCell).join(',');

export const csvDocument = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
