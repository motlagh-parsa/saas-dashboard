// Request-body building blocks for the REST API, and the wire formats it
// answers in. Plain module (zod and formatting only) so the verify script can
// use it as-is.
//
// The API speaks JSON with snake_case fields, money as integer minor units, and
// dates as YYYY-MM-DD. The limits are the UI's (lib/billing-form.ts), stated
// again in API terms: a caller sends 4999, not "49.99", so the form's money
// parser does not apply, but the same bounds do.
import type { BillingInterval } from "@prisma/client";
import { z } from "zod";

import {
  CUSTOMER_NAME_MAX,
  EMAIL_MAX,
  MAX_INTERVAL_COUNT,
  MIN_DAY,
  PLAN_NAME_MAX,
  QUANTITY_MAX,
  dateToDay,
  dayToDate,
  maxFutureDay,
  todayUtc,
} from "@/lib/billing-form";
import { MAX_MINOR_UNITS } from "@/lib/money";

import { invalid } from "./errors";

/**
 * A caller's ID for a record — the `{external_id}` in the URL. No colon: a
 * subscription's segments are stored as `<external_id>:<start date>`, the
 * scheme CSV import uses too, so the two sources recognise each other's rows.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,191}$/;
const EXTERNAL_ID_MESSAGE = "Use 1–191 letters, digits, `_`, `-` or `.`.";

export const externalIdSchema = z.string().regex(EXTERNAL_ID_PATTERN, { error: EXTERNAL_ID_MESSAGE });

/** The `{external_id}` path segment, or a 400 naming it. */
export function externalIdParam(value: string, param: string = "external_id"): string {
  const decoded = safeDecode(value);
  if (decoded === null || !EXTERNAL_ID_PATTERN.test(decoded)) {
    throw invalid(`${param}: ${EXTERNAL_ID_MESSAGE}`, param);
  }
  return decoded;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dayToDate(value);
  return !Number.isNaN(parsed.getTime()) && dateToDay(parsed) === value;
}

/** A YYYY-MM-DD from MIN_DAY to a year ahead (or today), as its UTC midnight. */
export function daySchema(max: "future" | "today" = "future") {
  return z
    .string({ error: "Send a date as YYYY-MM-DD." })
    .refine(isRealDay, { error: "Send a real date as YYYY-MM-DD." })
    .refine((value) => value >= MIN_DAY, { error: `Use a date on or after ${MIN_DAY}.` })
    .refine((value) => value <= (max === "today" ? todayUtc() : maxFutureDay()), {
      error: max === "today" ? "Use today or an earlier date (UTC)." : "Use a date within a year from today.",
    })
    .transform(dayToDate);
}

/** Integer minor units: 4999 is 49.99 in USD, 4999 yen in JPY. */
export function amountSchema(options: { readonly allowZero: boolean }) {
  return z
    .number({ error: "Send the amount as an integer in minor units (4999 = 49.99)." })
    .int({ error: "Send the amount as an integer in minor units (4999 = 49.99)." })
    .min(options.allowZero ? 0 : 1, { error: options.allowZero ? "Use 0 or more." : "Use an amount above zero." })
    .max(MAX_MINOR_UNITS, { error: `Use at most ${MAX_MINOR_UNITS}.` });
}

export const quantitySchema = z
  .number({ error: "Send a whole number of seats." })
  .int({ error: "Send a whole number of seats." })
  .min(1, { error: `Use between 1 and ${QUANTITY_MAX}.` })
  .max(QUANTITY_MAX, { error: `Use between 1 and ${QUANTITY_MAX}.` });

export const intervalSchema = z
  .enum(["month", "year"], { error: "Use `month` or `year`." })
  .transform((value): BillingInterval => (value === "year" ? "YEAR" : "MONTH"));

export const intervalCountSchema = z
  .number({ error: "Send a whole number." })
  .int({ error: "Send a whole number." });

export const customerNameSchema = z
  .string({ error: "Send the customer's name." })
  .trim()
  .min(1, { error: "Send the customer's name." })
  .max(CUSTOMER_NAME_MAX, { error: `Use at most ${CUSTOMER_NAME_MAX} characters.` });

export const emailSchema = z
  .email({ error: "Send a valid email address." })
  .max(EMAIL_MAX, { error: `Use at most ${EMAIL_MAX} characters.` })
  .transform((value) => value.toLowerCase());

export const planNameSchema = z
  .string({ error: "Send the plan's name." })
  .trim()
  .min(1, { error: "Send the plan's name." })
  .max(PLAN_NAME_MAX, { error: `Use at most ${PLAN_NAME_MAX} characters.` });

/** Adds the "1–36 months / 1–3 years" issue at `path` when the count is out of range. */
export function checkIntervalCount(
  interval: BillingInterval,
  count: number,
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const max = MAX_INTERVAL_COUNT[interval];
  if (count < 1 || count > max) {
    ctx.addIssue({
      code: "custom",
      path: [...path],
      message: `Use 1 to ${max} for a ${interval === "MONTH" ? "monthly" : "yearly"} interval.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Wire formats out
// ---------------------------------------------------------------------------

export function wireDay(value: Date): string;
export function wireDay(value: Date | null): string | null;
export function wireDay(value: Date | null): string | null {
  return value === null ? null : dateToDay(value);
}

export function wireInstant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function wireInterval(interval: BillingInterval): "month" | "year" {
  return interval === "YEAR" ? "year" : "month";
}

/** An enum value as the API spells it: PAST_DUE -> past_due. */
export function wireEnum<T extends string>(value: T): Lowercase<T> {
  return value.toLowerCase() as Lowercase<T>;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export interface PageParams {
  readonly limit: number;
  /** A Meridian record id: the page starts after it. */
  readonly startingAfter: string | null;
}

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `limit` and `starting_after` from the query string, or a 400 naming the bad one. */
export function pageParams(query: URLSearchParams): PageParams {
  const rawLimit = query.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
      throw invalid(`limit: Use a whole number from 1 to ${MAX_LIMIT}.`, "limit");
    }
    limit = Number(rawLimit);
  }
  const startingAfter = query.get("starting_after");
  if (startingAfter !== null && !CURSOR_PATTERN.test(startingAfter)) {
    throw invalid("starting_after: Use the `id` of the last record of the previous page.", "starting_after");
  }
  return { limit, startingAfter };
}

export interface ListBody<T> {
  readonly object: "list";
  readonly data: readonly T[];
  readonly has_more: boolean;
  /** Pass as `starting_after` for the next page; null on the last one. */
  readonly next_cursor: string | null;
}

/** Rows fetched with `take: limit + 1`, as one page. */
export function listBody<R extends { readonly id: string }, T>(
  rows: readonly R[],
  limit: number,
  toWire: (row: R) => T,
): ListBody<T> {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    object: "list",
    data: page.map(toWire),
    has_more: hasMore,
    next_cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** A YYYY-MM-DD query parameter, or a 400 naming it. */
export function dayParam(query: URLSearchParams, name: string): Date | null {
  const raw = query.get(name);
  if (raw === null || raw === "") return null;
  if (!isRealDay(raw)) throw invalid(`${name}: Send a real date as YYYY-MM-DD.`, name);
  return dayToDate(raw);
}
