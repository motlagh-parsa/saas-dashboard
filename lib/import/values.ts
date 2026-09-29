// Reading the values in an imported file: amounts, dates, statuses, intervals.
//
// Isomorphic: the wizard runs the detectors to decide which questions to ask
// (is "1,234" a thousand or one-point-something? is 03/04 March or April?), and
// the server parses every value with the same functions and the answers given.
// Nothing ambiguous is ever guessed: a detector that cannot tell says so.
import type { BillingInterval, InvoiceStatus, SubscriptionStatus } from "@prisma/client";

import { MIN_DAY, maxFutureDay, todayUtc } from "@/lib/billing-form";
import { currencyFractionDigits } from "@/lib/format";
import { MAX_MINOR_UNITS } from "@/lib/money";

export type DecimalSeparator = "point" | "comma";
/** Only slash-style dates need an order; ISO and Unix timestamps never do. */
export type DateOrder = "dmy" | "mdy";

export interface ImportOptions {
  /** Amounts are already in the currency's smallest unit (Stripe's `amount` columns). */
  readonly amountsInCents: boolean;
  readonly decimal: DecimalSeparator;
  /** Required only when the file has slash dates; null otherwise. */
  readonly dateOrder: DateOrder | null;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** "Past Due", "past-due", " PAST_DUE " -> "past_due". */
export function token(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Currency symbols, codes and spaces around a number: "$1,299.00", "EUR 49", "49 €". */
function stripAmount(raw: string): string {
  return raw.replace(/[^\d.,-]/g, "");
}

/**
 * Which decimal separator a file's amounts use. `point` and `comma` only when
 * the values prove it ("1.234,56", "49,90" vs "1,234.56", "49.90"); a file of
 * whole numbers is `point` (nothing to decide); values like "1,234" alone —
 * a thousand, or 1.234 in a decimal-comma locale — are `ambiguous`.
 */
export function detectDecimal(samples: readonly string[]): DecimalSeparator | "ambiguous" {
  let point = false;
  let comma = false;
  let unsure = false;
  for (const sample of samples) {
    const value = stripAmount(sample);
    if (!value) continue;
    if (/\d\.\d{3},\d{1,2}$/.test(value) || /,\d{1,2}$/.test(value)) comma = true;
    else if (/\d,\d{3}\.\d{1,2}$/.test(value) || /\.\d{1,2}$/.test(value)) point = true;
    else if (/[.,]\d{3}$/.test(value)) unsure = true;
  }
  if (point && !comma) return "point";
  if (comma && !point) return "comma";
  if (point && comma) return "ambiguous";
  return unsure ? "ambiguous" : "point";
}

/**
 * An amount as integer minor units of `currency`. Major units by default
 * ("49.99" -> 4999 for USD); with `amountsInCents` the value already is the
 * smallest unit ("4999" -> 4999). Thousands separators and currency symbols are
 * stripped; negative amounts are refused.
 */
export function parseAmount(raw: string, currency: string, options: ImportOptions): Parsed<number> {
  const value = stripAmount(raw);
  if (!value) return err(`“${raw}” is not an amount.`);
  if (value.startsWith("-")) return err(`Amounts can't be negative (“${raw}”).`);

  let minor: number;
  if (options.amountsInCents) {
    // Smallest units are whole: "4999" or "4,999" (thousands) — never a fraction.
    const whole = value.replace(/[.,]/g, "");
    if (!/^\d{1,13}$/.test(whole)) return err(`“${raw}” is not a whole number of cents.`);
    minor = Number(whole);
  } else {
    const digits = currencyFractionDigits(currency);
    const [thousands, decimal] = options.decimal === "comma" ? [".", ","] : [",", "."];
    const cleaned = value.split(thousands).join("");
    const parts = cleaned.split(decimal);
    if (parts.length > 2 || !/^\d+$/.test(parts[0] ?? "") || (parts[1] !== undefined && !/^\d*$/.test(parts[1]))) {
      return err(`“${raw}” is not an amount.`);
    }
    const fraction = parts[1] ?? "";
    if (fraction.length > digits) {
      return err(
        digits === 0
          ? `“${raw}” has decimals, but this currency has no minor unit.`
          : `“${raw}” has more than ${digits} decimals.`,
      );
    }
    minor = Number(parts[0]) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  }
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_UNITS) return err(`“${raw}” is too large.`);
  return ok(minor);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC)?)?$/i;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/;
const UNIX = /^\d{9,13}(\.\d+)?$/;

function utcMidnight(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function midnightOf(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/**
 * What the slash dates in a file need: `dmy` or `mdy` when a value proves it
 * (a first part over 12 means day-first), `ambiguous` when every value could be
 * either, `none` when there are no slash dates at all (ISO / Unix only), and
 * `conflict` when some values prove one order and some the other.
 */
export function detectDateOrder(samples: readonly string[]): DateOrder | "ambiguous" | "none" | "conflict" {
  let seen = false;
  let dayFirst = false;
  let monthFirst = false;
  for (const sample of samples) {
    const match = SLASH.exec(sample.trim());
    if (!match) continue;
    seen = true;
    if (Number(match[1]) > 12) dayFirst = true;
    if (Number(match[2]) > 12) monthFirst = true;
  }
  if (!seen) return "none";
  if (dayFirst && monthFirst) return "conflict";
  if (dayFirst) return "dmy";
  if (monthFirst) return "mdy";
  return "ambiguous";
}

/**
 * A date as its UTC midnight — the instant every billing date is stored as.
 * ISO 8601 (a time and offset are converted to UTC before the day is taken),
 * Unix seconds (or milliseconds), and slash dates in the file's `dateOrder`.
 * `max`: "future" allows up to a year ahead (like manual entry), "today" no later.
 */
export function parseDate(
  raw: string,
  options: ImportOptions,
  max: "future" | "today" = "future",
): Parsed<Date> {
  const value = raw.trim();
  let date: Date | null = null;

  const iso = ISO.exec(value);
  const slash = iso ? null : SLASH.exec(value);
  if (iso) {
    const [, y, m, d, , , , zone] = iso;
    if (zone && zone.toUpperCase() !== "UTC") {
      // An explicit offset: convert the instant to UTC, then take its day.
      const instant = new Date(value.replace(" ", "T").replace(/UTC$/i, "Z"));
      date = Number.isNaN(instant.getTime()) ? null : midnightOf(instant);
    } else {
      date = utcMidnight(Number(y), Number(m), Number(d));
    }
  } else if (slash) {
    if (options.dateOrder === null) return err(`“${raw}” could be day/month or month/day — choose the date order.`);
    const [first, second] = [Number(slash[1]), Number(slash[2])];
    const [day, month] = options.dateOrder === "dmy" ? [first, second] : [second, first];
    date = utcMidnight(Number(slash[3]), month, day);
  } else if (UNIX.test(value)) {
    const number = Number(value);
    const ms = number >= 1e11 ? number : number * 1000;
    date = midnightOf(new Date(ms));
  } else {
    return err(`“${raw}” is not a date Meridian understands (use YYYY-MM-DD).`);
  }

  if (date === null) return err(`“${raw}” is not a real date.`);
  const day = date.toISOString().slice(0, 10);
  if (day < MIN_DAY) return err(`${day} is before ${MIN_DAY}.`);
  if (max === "today" && day > todayUtc()) return err(`${day} is in the future.`);
  if (max === "future" && day > maxFutureDay()) return err(`${day} is more than a year from today.`);
  return ok(date);
}

// ---------------------------------------------------------------------------
// Statuses and intervals
// ---------------------------------------------------------------------------

const SUBSCRIPTION_STATUS: Record<string, SubscriptionStatus> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  trial: "TRIALING",
  in_trial: "TRIALING",
  past_due: "PAST_DUE",
  pastdue: "PAST_DUE",
  unpaid: "PAST_DUE",
  overdue: "PAST_DUE",
  // Chargebee: active until the period ends, then canceled — the end date says when.
  non_renewing: "ACTIVE",
  canceled: "CANCELED",
  cancelled: "CANCELED",
  ended: "CANCELED",
  expired: "CANCELED",
  inactive: "CANCELED",
};

export function parseSubscriptionStatus(raw: string): Parsed<SubscriptionStatus> {
  if (!raw.trim()) return ok("ACTIVE");
  const status = SUBSCRIPTION_STATUS[token(raw)];
  return status ? ok(status) : err(`Unknown subscription status “${raw}” (use active, trialing, past_due or canceled).`);
}

const INVOICE_STATUS: Record<string, InvoiceStatus> = {
  draft: "DRAFT",
  open: "OPEN",
  unpaid: "OPEN",
  pending: "OPEN",
  due: "OPEN",
  payment_due: "OPEN",
  posted: "OPEN",
  not_paid: "OPEN",
  paid: "PAID",
  succeeded: "PAID",
  settled: "PAID",
  void: "VOID",
  voided: "VOID",
  uncollectible: "UNCOLLECTIBLE",
  written_off: "UNCOLLECTIBLE",
  bad_debt: "UNCOLLECTIBLE",
};

export function parseInvoiceStatus(raw: string): Parsed<InvoiceStatus> {
  const status = INVOICE_STATUS[token(raw)];
  return status ? ok(status) : err(`Unknown invoice status “${raw}” (use draft, open, paid, void or uncollectible).`);
}

const INTERVALS: Record<string, { interval: BillingInterval; count: number }> = {
  month: { interval: "MONTH", count: 1 },
  months: { interval: "MONTH", count: 1 },
  monthly: { interval: "MONTH", count: 1 },
  mo: { interval: "MONTH", count: 1 },
  m: { interval: "MONTH", count: 1 },
  quarter: { interval: "MONTH", count: 3 },
  quarterly: { interval: "MONTH", count: 3 },
  year: { interval: "YEAR", count: 1 },
  years: { interval: "YEAR", count: 1 },
  yearly: { interval: "YEAR", count: 1 },
  annual: { interval: "YEAR", count: 1 },
  annually: { interval: "YEAR", count: 1 },
  yr: { interval: "YEAR", count: 1 },
  y: { interval: "YEAR", count: 1 },
};

/**
 * An interval word and an optional count column: "month" + "3" -> MONTH × 3.
 * "quarterly" already means MONTH × 3 (and multiplies a count).
 */
export function parseInterval(
  raw: string,
  rawCount: string,
): Parsed<{ interval: BillingInterval; intervalCount: number }> {
  const known = INTERVALS[token(raw)];
  if (!known) {
    return err(`Unknown interval “${raw}”. Meridian bills monthly or yearly (quarterly = every 3 months).`);
  }
  let count = 1;
  if (rawCount.trim()) {
    if (!/^\d{1,2}$/.test(rawCount.trim())) return err(`Interval count “${rawCount}” is not a whole number.`);
    count = Number(rawCount.trim());
  }
  const intervalCount = known.count * count;
  const max = known.interval === "MONTH" ? 36 : 3;
  if (intervalCount < 1 || intervalCount > max) {
    return err(`Bill every 1 to ${max} ${known.interval === "MONTH" ? "months" : "years"} (row says ${intervalCount}).`);
  }
  return ok({ interval: known.interval, intervalCount });
}

export function parseQuantity(raw: string): Parsed<number> {
  if (!raw.trim()) return ok(1);
  const value = raw.trim();
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 10_000) {
    return err(`Quantity “${raw}” must be a whole number from 1 to 10,000.`);
  }
  return ok(Number(value));
}

/** An optional currency column must be the workspace's currency. */
export function checkCurrency(raw: string, workspaceCurrency: string): string | null {
  const value = raw.trim().toUpperCase();
  if (!value || value === workspaceCurrency.toUpperCase()) return null;
  return `This workspace reports in ${workspaceCurrency.toUpperCase()}; row is ${value}.`;
}
