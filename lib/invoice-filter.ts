import type { InvoiceStatus } from "@prisma/client";

import type { InvoiceCursor } from "@/lib/metrics";

/**
 * URL state for the invoice ledger on the revenue page.
 *
 * Everything here narrows an UNTRUSTED query param down to a value the metrics
 * layer will accept. Nothing in this module builds SQL, and nothing it returns
 * can widen a query: statuses come from a fixed whitelist, and a cursor is only
 * ever reconstructed from an epoch plus an id that matches a strict pattern.
 *
 * Type-only imports on both sides: `lib/metrics.ts` is `server-only` and
 * `@prisma/client` is a server package, but `import type` is erased at compile
 * time, so this module stays safe to reach from anywhere — the same reason
 * `lib/period.ts` can name a `Period`.
 */

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

export type StatusFilterKey = "all" | "paid" | "open";

export interface StatusFilterOption {
  readonly key: StatusFilterKey;
  /** Segmented-control label. */
  readonly label: string;
  /**
   * Handed straight to `getInvoices({ statuses })`. Empty means every status —
   * the metrics layer already treats an empty list as "no filter".
   */
  readonly statuses: readonly InvoiceStatus[];
  /** Reads as the tail of "No … in this workspace" when the filter empties the table. */
  readonly emptyNoun: string;
}

/**
 * The three states worth filtering on. DRAFT, VOID and UNCOLLECTIBLE exist in the
 * schema but are not offered: they are rare enough that a chip for each would
 * cost more attention than it returns, and "All" still reaches them.
 */
export const STATUS_FILTERS: readonly StatusFilterOption[] = [
  { key: "all", label: "All", statuses: [], emptyNoun: "invoices" },
  { key: "paid", label: "Paid", statuses: ["PAID"], emptyNoun: "paid invoices" },
  { key: "open", label: "Open", statuses: ["OPEN"], emptyNoun: "open invoices" },
];

const DEFAULT_STATUS: StatusFilterKey = "all";

/**
 * Narrows an untrusted `?status=` param to a known key. Anything unrecognised —
 * including the repeated-param array form — falls back to "all" rather than
 * erroring, because a mangled URL should still render the table.
 */
export function parseStatusFilter(raw: string | string[] | undefined): StatusFilterKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = STATUS_FILTERS.find((option) => option.key === value);
  return match ? match.key : DEFAULT_STATUS;
}

export function statusFilterOption(key: StatusFilterKey): StatusFilterOption {
  return STATUS_FILTERS.find((option) => option.key === key) ?? STATUS_FILTERS[0];
}

// ---------------------------------------------------------------------------
// Keyset cursor stack
// ---------------------------------------------------------------------------

/**
 * `InvoiceListResult.nextCursor` pages FORWARD ONLY — there is no "previous
 * cursor" to ask the database for. So the history lives in the URL instead: the
 * `cursors` param holds the cursor used to fetch the current page and every page
 * before it, oldest first.
 *
 *   page 1 -> []            (no cursor)
 *   page 2 -> [c1]          (c1 = page 1's nextCursor)
 *   page 3 -> [c1, c2]
 *
 * Forward is `[...stack, next]`, back is `stack.slice(0, -1)`, and the page
 * number is `stack.length + 1`. That makes Back a real navigation to a page the
 * reader actually visited, not a guess.
 *
 * The ceiling is URL length: a token is ~40 characters, so `MAX_CURSOR_STACK`
 * pages stay far inside every browser and proxy limit.
 */
const CURSOR_FIELD_SEPARATOR = ".";
const CURSOR_STACK_SEPARATOR = "~";
/** cuid ids are alphanumeric; the class stays tight so nothing exotic reaches the query. */
const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CURSOR_STACK = 40;
/** 2100-01-01, an upper bound no real `issuedAt` reaches. */
const MAX_EPOCH_MS = 4_102_444_800_000;

export function encodeCursor(cursor: InvoiceCursor): string {
  return `${cursor.issuedAt.getTime()}${CURSOR_FIELD_SEPARATOR}${cursor.id}`;
}

/** `null` for anything malformed. Callers treat that as "start from page one". */
export function decodeCursor(token: string): InvoiceCursor | null {
  const split = token.indexOf(CURSOR_FIELD_SEPARATOR);
  if (split <= 0) return null;

  const epoch = Number(token.slice(0, split));
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH_MS) return null;

  const id = token.slice(split + 1);
  if (!CURSOR_ID_PATTERN.test(id)) return null;

  return { issuedAt: new Date(epoch), id };
}

/**
 * Reads the whole stack, or nothing.
 *
 * One bad token invalidates every token: repairing the stack by dropping the bad
 * entry would leave "Back" pointing at a page the reader never visited, which is
 * worse than starting over.
 */
export function parseCursorStack(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];

  const tokens = value.split(CURSOR_STACK_SEPARATOR);
  if (tokens.length > MAX_CURSOR_STACK) return [];
  return tokens.every((token) => decodeCursor(token) !== null) ? tokens : [];
}

export function encodeCursorStack(cursors: readonly string[]): string {
  return cursors.join(CURSOR_STACK_SEPARATOR);
}
