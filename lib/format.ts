/**
 * Display-layer formatting.
 *
 * `lib/metrics.ts` deals only in integer minor units (cents) and raw fractions
 * (0.12 = +12%, 1.12 = 112% NRR). Every number crossing into the UI goes through
 * this module, and nothing above it does currency arithmetic.
 *
 * Two rules hold everywhere in here:
 *   - `null` is meaningful. It means "undefined", not zero, so it renders as an
 *     em-dash and never as "0%" or "NaN".
 *   - Fractions are multiplied by 100 exactly once — at the point of rendering.
 *
 * Safe on both sides of the server/client boundary: no imports, no side effects.
 */

/** Rendered wherever a value is genuinely undefined. */
export const EM_DASH = "—";

/** Unicode minus, not a hyphen — it matches the width of a digit in Geist Mono. */
const MINUS = "−";

const ISO_4217 = /^[A-Za-z]{3}$/;
const LOCALE = "en-US";

const numberFormatters = new Map<string, Intl.NumberFormat>();

function cached(key: string, build: () => Intl.NumberFormat): Intl.NumberFormat {
  const hit = numberFormatters.get(key);
  if (hit) return hit;
  const formatter = build();
  numberFormatters.set(key, formatter);
  return formatter;
}

/**
 * Guards `Intl.NumberFormat`, which throws a RangeError on a malformed code.
 * A bad currency in the database should degrade to a readable number, not a 500.
 */
function safeCurrency(currency: string): string {
  return ISO_4217.test(currency) ? currency.toUpperCase() : "USD";
}

// ---------------------------------------------------------------------------
// Money — input is always integer cents
// ---------------------------------------------------------------------------

/** Headline money: `$52,480`. Whole units, because dashboards are read, not audited. */
export function formatMoney(cents: number, currency: string): string {
  const code = safeCurrency(currency);
  return cached(`money:${code}`, () =>
    new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }),
  ).format(cents / 100);
}

/** Ledger money: `$1,299.00`. Used where the exact figure is the point (invoices). */
export function formatMoneyExact(cents: number, currency: string): string {
  const code = safeCurrency(currency);
  return cached(`exact:${code}`, () =>
    new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  ).format(cents / 100);
}

/** Axis money: `$52.5K`. Compact enough to sit in a tick without wrapping. */
export function formatMoneyCompact(cents: number, currency: string): string {
  const code = safeCurrency(currency);
  return cached(`compact:${code}`, () =>
    new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
  ).format(cents / 100);
}

/**
 * Money with an explicit direction, for ledger movement rows: `+$6,100`.
 * The metrics layer reports expansion/contraction/churn as positive magnitudes,
 * so the sign is a presentation decision made here.
 */
export function formatMoneyMovement(
  cents: number,
  currency: string,
  direction: "add" | "subtract",
): string {
  const amount = formatMoney(Math.abs(cents), currency);
  if (cents === 0) return amount;
  return `${direction === "add" ? "+" : MINUS}${amount}`;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function formatCount(value: number): string {
  return cached("count", () => new Intl.NumberFormat(LOCALE)).format(value);
}

/** `+6` / `−6` / `0`. */
export function formatSignedCount(value: number): string {
  return cached("signedCount", () =>
    new Intl.NumberFormat(LOCALE, { signDisplay: "exceptZero" }),
  ).format(value);
}

// ---------------------------------------------------------------------------
// Rates — input is a FRACTION
// ---------------------------------------------------------------------------

/** `3.4%`, or an em-dash when the rate is undefined. */
export function formatPercent(fraction: number | null, digits: number = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return EM_DASH;
  return cached(`pct:${digits}`, () =>
    new Intl.NumberFormat(LOCALE, {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  ).format(fraction);
}

/** `+12.4%` — a period-over-period change, which always carries its sign. */
export function formatSignedPercent(fraction: number | null, digits: number = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return EM_DASH;
  return cached(`signedPct:${digits}`, () =>
    new Intl.NumberFormat(LOCALE, {
      style: "percent",
      signDisplay: "exceptZero",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  ).format(fraction);
}

/**
 * A percentage-POINT delta: `+2.1 pts`.
 *
 * This is the honest comparison for a rate. A "percent change of a percentage"
 * (3% -> 4% reported as "+33%") reads as a catastrophe when it is one point.
 */
export function formatPoints(fraction: number | null, digits: number = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return EM_DASH;
  const value = cached(`signedNum:${digits}`, () =>
    new Intl.NumberFormat(LOCALE, {
      signDisplay: "exceptZero",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  ).format(fraction * 100);
  return `${value} pts`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * `"2026-03"` -> `"Mar"`. Parsed by hand rather than through `new Date(...)`:
 * `new Date("2026-03")` is UTC-midnight, which renders as February in any
 * negative-offset time zone.
 */
export function formatMonthShort(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  if (!Number.isInteger(index) || index < 0 || index > 11) return month;
  return MONTH_NAMES[index];
}

/** `"2026-03"` -> `"Mar 2026"`. */
export function formatMonthLong(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  if (!Number.isInteger(index) || index < 0 || index > 11) return month;
  return `${MONTH_NAMES[index]} ${month.slice(0, 4)}`;
}

const dayFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  // Metric timestamps are UTC wall-clock instants (see lib/metrics.ts). Rendering
  // them in the server's local zone would shift dates across midnight.
  timeZone: "UTC",
});

/** `16 Aug 2026`. Server-side only, so there is no client/server locale skew. */
export function formatDay(value: Date): string {
  return dayFormatter.format(value);
}

// ---------------------------------------------------------------------------
// People and labels — a name is optional in the schema, an email never is
// ---------------------------------------------------------------------------

/** Splits on the separators a display name or a handle actually uses. */
const NAME_SEPARATORS = /[\s._+-]+/;

/**
 * The name to print for a person.
 *
 * `User.name` is nullable — an OAuth account can arrive without one, and a
 * credentials user is created from an email alone. `User.email` is not nullable,
 * so the local part of the address is the fallback: it is the closest thing to a
 * chosen name the record actually holds, and it never renders as blank.
 *
 * Never returns an empty string. A row with no legible identity is worse than a
 * row that admits it has none.
 */
export function formatPersonName(name: string | null, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;

  const local = email.split("@")[0]?.trim();
  if (local) return local;

  return email.trim() || "Unnamed member";
}

/**
 * Up to two initials for an avatar fallback: `"Ada Lovelace"` -> `"AL"`,
 * `"ada.lovelace"` -> `"AL"`, `"northwind"` -> `"N"`.
 *
 * Takes an already-resolved label rather than a name/email pair, so the same
 * function serves a person (via `formatPersonName`) and a workspace, and neither
 * caller has to know how the other resolves its source string.
 */
export function formatInitials(source: string): string {
  const words = source.trim().split(NAME_SEPARATORS).filter(Boolean);
  if (words.length === 0) return "?";

  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";

  return `${first}${last}`.toUpperCase() || "?";
}

// ---------------------------------------------------------------------------
// Enum labels — the database speaks SCREAMING_CASE, the interface does not
// ---------------------------------------------------------------------------

/** `"PAST_DUE"` -> `"Past due"`. */
export function formatEnumLabel(value: string): string {
  const words = value.toLowerCase().split("_");
  const [first, ...rest] = words;
  if (first === undefined) return value;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
