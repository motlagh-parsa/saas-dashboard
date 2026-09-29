// The CSV writer every export shares: users, customers, invoices.
//
// Formula-neutralizing on purpose. Names, emails and plan names are typed by
// users, so a value like `=HYPERLINK(...)` must arrive in a spreadsheet as text,
// not run on the machine of the admin who opened the file. Prefixing an
// apostrophe is OWASP's recommended neutralisation.
//
// Output is RFC 4180: every field quoted, quotes doubled, CRLF line endings, and
// a UTF-8 byte-order mark so Excel reads accented names correctly.

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** `=cmd` -> `'=cmd`; anything else unchanged. */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One RFC 4180 field: formula-guarded, quotes doubled, always quoted. */
export function csvField(value: string): string {
  return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}

/**
 * A whole file from a header and rows of TEXT cells. Numbers are the caller's to
 * stringify: a negative amount is text that starts with "-", and guarding it is
 * the price of treating every cell the same way.
 */
export function buildCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** `users-northwind-analytics-2026-09-28.csv` */
export function csvFilename(kind: string, slug: string): string {
  return `${kind}-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
}

/** What every export action returns: the file's text and a name to save it under. */
export type CsvExportResult =
  | { readonly status: "success"; readonly csv: string; readonly filename: string; readonly count: number }
  | { readonly status: "error"; readonly message: string };
