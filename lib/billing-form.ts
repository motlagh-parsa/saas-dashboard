// The billing forms' rules and result shape — customers, plans, subscriptions
// and invoices — shared by the client dialogs (instant feedback) and the Server
// Actions (the check that counts), so the two can never disagree.
//
// A plain module: a `"use server"` module cannot export a schema, a type or a
// constant, and the client imports this directly.
//
// Every form posts STRINGS. Each schema takes the raw text of its fields (the
// dialog's draft on the client, the FormData on the server — see `readForm`) and
// produces typed values: money as integer minor units of the workspace currency
// (lib/money.ts), dates as UTC midnights, ids as cuid-shaped strings. The
// schemas are factories because money depends on the currency and date bounds
// depend on today.
import type { BillingInterval, InvoiceStatus, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

import { minorToInput, moneyInputExample, parseMoneyInput } from "@/lib/money";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface BillingFormState {
  readonly status: "idle" | "success" | "error";
  /** A form-level message (authorization, stale page, a refusal), or null. */
  readonly message: string | null;
  /** First message per field name. */
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export const IDLE_BILLING_FORM: BillingFormState = { status: "idle", message: null, fieldErrors: {} };

export type BillingAction = (previous: BillingFormState, formData: FormData) => Promise<BillingFormState>;

/** A form's raw text, keyed by field name. */
export type FormDraft = Readonly<Record<string, string>>;

/** The named fields of a submitted form as strings; a missing field is "". */
export function readForm(formData: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = formData.get(field);
    out[field] = typeof value === "string" ? value : "";
  }
  return out;
}

/** The first message for each field, from a failed parse. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    const field = typeof key === "string" ? key : "form";
    if (out[field] === undefined) out[field] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** cuid-shaped ids: nothing exotic reaches a WHERE clause. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const idSchema = z.string().regex(ID_PATTERN, { error: "This page is out of date. Reload it and try again." });

/** Picker value meaning "create a new customer from the name field". */
export const NEW_CUSTOMER = "__new_customer__";
/** Picker value meaning "no plan — a custom price and interval". */
export const CUSTOM_PRICE = "__custom_price__";

export const CUSTOMER_NAME_MAX = 100;
export const PLAN_NAME_MAX = 60;
export const EMAIL_MAX = 254;
export const QUANTITY_MAX = 10_000;
/** Stripe's limits: at most 3 years, or 36 months, per billing period. */
export const MAX_INTERVAL_COUNT: Record<BillingInterval, number> = { MONTH: 36, YEAR: 3 };

/** The earliest date any billing record may carry. */
export const MIN_DAY = "2000-01-01";

/** Today's date in UTC as `YYYY-MM-DD` — the day boundary every metric uses. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` one year from today (UTC): the furthest a future date may go. */
export function maxFutureDay(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  return todayUtc(next);
}

/** `YYYY-MM-DD` -> that day's UTC midnight, the instant every billing date is stored as. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A stored instant -> the `YYYY-MM-DD` a date input holds. */
export function dateToDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dayToDate(value);
  return !Number.isNaN(parsed.getTime()) && dateToDay(parsed) === value;
}

/**
 * A date input: a real calendar day between `MIN_DAY` and `max` (inclusive,
 * default one year ahead), as its UTC midnight.
 */
function daySchema(label: string, max: "future" | "today" = "future") {
  return z
    .string()
    .refine(isRealDay, { error: `Choose ${label}.` })
    .refine((value) => value >= MIN_DAY, { error: `Pick a date on or after ${MIN_DAY}.` })
    .refine((value) => value <= (max === "today" ? todayUtc() : maxFutureDay()), {
      error: max === "today" ? "Pick today or an earlier date (UTC)." : "Pick a date within a year from today.",
    })
    .transform(dayToDate);
}

/** An optional date: "" is none. */
function optionalDaySchema(label: string, max: "future" | "today" = "future") {
  return z.union([z.literal("").transform(() => null), daySchema(label, max)]);
}

/** Major units typed ("49.99") -> integer minor units of `currency`. */
function moneySchema(currency: string, options: { readonly allowZero: boolean }) {
  const example = moneyInputExample(currency);
  return z
    .string()
    .transform((value, ctx) => {
      const minor = parseMoneyInput(value, currency);
      if (minor === null) {
        ctx.addIssue({ code: "custom", message: `Enter an amount like ${example}.` });
        return z.NEVER;
      }
      if (!options.allowZero && minor === 0) {
        ctx.addIssue({ code: "custom", message: "Enter an amount above zero." });
        return z.NEVER;
      }
      return minor;
    });
}

const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,5}$/, { error: "Enter a whole number of seats." })
  .transform(Number)
  .refine((value) => value >= 1 && value <= QUANTITY_MAX, {
    error: `Use between 1 and ${QUANTITY_MAX.toLocaleString("en-US")}.`,
  });

const intervalSchema = z.enum(["MONTH", "YEAR"], { error: "Choose month or year." });

const intervalCountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}$/, { error: "Enter how many months or years." })
  .transform(Number);

/** Checks the interval count against its unit — 36 months, or 3 years, at most. */
function checkIntervalCount(
  interval: BillingInterval,
  count: number,
  ctx: z.RefinementCtx,
  path: string = "intervalCount",
): void {
  const max = MAX_INTERVAL_COUNT[interval];
  if (count < 1 || count > max) {
    ctx.addIssue({
      code: "custom",
      path: [path],
      message: `Bill every 1 to ${max} ${interval === "MONTH" ? "months" : "years"}.`,
    });
  }
}

/** The statuses a live subscription can be put in by hand. CANCELED is an event, not a choice. */
export const LIVE_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const satisfies readonly SubscriptionStatus[];

/** The statuses an invoice can be recorded in. The rest are reached by row actions. */
export const RECORD_STATUSES = ["DRAFT", "OPEN", "PAID"] as const satisfies readonly InvoiceStatus[];

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_FIELDS = ["name", "email"] as const;

const customerNameSchema = z
  .string()
  .trim()
  .min(2, { error: "Enter the customer's name (at least 2 characters)." })
  .max(CUSTOMER_NAME_MAX, { error: `Use at most ${CUSTOMER_NAME_MAX} characters.` });

const optionalEmailSchema = z.union([
  z.string().trim().length(0).transform(() => null),
  z
    .string()
    .trim()
    .max(EMAIL_MAX, { error: "That email is too long." })
    .pipe(z.email({ error: "Enter a valid email, or leave it blank." }))
    .transform((value) => value.toLowerCase()),
]);

export function customerSchema() {
  return z.object({ name: customerNameSchema, email: optionalEmailSchema });
}

/** Deleting a customer asks for their name, typed exactly. */
export const DELETE_CUSTOMER_FIELDS = ["customerId", "confirmName"] as const;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const PLAN_FIELDS = ["name", "price", "interval", "intervalCount"] as const;

export function planSchema(currency: string) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, { error: "Name the plan." })
        .max(PLAN_NAME_MAX, { error: `Use at most ${PLAN_NAME_MAX} characters.` }),
      // A free plan is allowed: it bills nothing and adds no MRR.
      price: moneySchema(currency, { allowZero: true }),
      interval: intervalSchema,
      intervalCount: intervalCountSchema,
    })
    .superRefine((values, ctx) => checkIntervalCount(values.interval, values.intervalCount, ctx));
}

export const PLAN_NAME_TAKEN = "A plan with this name already exists in this workspace.";

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const CREATE_SUBSCRIPTION_FIELDS = [
  "customerId",
  "newCustomerName",
  "planId",
  "price",
  "interval",
  "intervalCount",
  "quantity",
  "status",
  "startDate",
  "recordPastInvoices",
] as const;

/**
 * Create. Any start date from `MIN_DAY` up to a year ahead — history is entered
 * by hand, so the past is the normal case. Empty price means "the plan's price".
 */
export function createSubscriptionSchema(currency: string) {
  return z
    .object({
      customerId: z.string().refine((value) => value === NEW_CUSTOMER || ID_PATTERN.test(value), {
        error: "Choose a customer.",
      }),
      newCustomerName: z.string().trim().max(CUSTOMER_NAME_MAX, {
        error: `Use at most ${CUSTOMER_NAME_MAX} characters.`,
      }),
      planId: z.string().refine((value) => value === CUSTOM_PRICE || ID_PATTERN.test(value), {
        error: "Choose a plan.",
      }),
      price: z.union([z.literal("").transform(() => null), moneySchema(currency, { allowZero: true })]),
      interval: z.union([z.literal("").transform(() => null), intervalSchema]),
      intervalCount: z.union([z.literal("").transform(() => null), intervalCountSchema]),
      quantity: quantitySchema,
      status: z.enum(LIVE_STATUSES, { error: "Choose a status." }),
      startDate: daySchema("a start date"),
      recordPastInvoices: z.string().transform((value) => value === "on"),
    })
    .superRefine((values, ctx) => {
      if (values.customerId === NEW_CUSTOMER && values.newCustomerName.length < 2) {
        ctx.addIssue({
          code: "custom",
          path: ["newCustomerName"],
          message: "Enter the customer's name (at least 2 characters).",
        });
      }
      if (values.planId === CUSTOM_PRICE) {
        if (values.price === null) {
          ctx.addIssue({ code: "custom", path: ["price"], message: "Enter the custom price." });
        }
        if (values.interval === null) {
          ctx.addIssue({ code: "custom", path: ["interval"], message: "Choose month or year." });
        } else if (values.intervalCount === null) {
          ctx.addIssue({ code: "custom", path: ["intervalCount"], message: "Enter how many months or years." });
        } else {
          checkIntervalCount(values.interval, values.intervalCount, ctx);
        }
      }
    });
}

export const CHANGE_SUBSCRIPTION_FIELDS = [
  "subscriptionId",
  "planId",
  "price",
  "interval",
  "intervalCount",
  "quantity",
  "effectiveDate",
] as const;

/**
 * Change plan / change quantity. One schema for both dialogs: the quantity
 * dialog posts the current plan and price unchanged. The effective date may be
 * in the past (not before the current terms began — checked against the row) or
 * up to a year ahead.
 */
export function changeSubscriptionSchema(currency: string) {
  return z
    .object({
      subscriptionId: idSchema,
      planId: z.string().refine((value) => value === CUSTOM_PRICE || ID_PATTERN.test(value), {
        error: "Choose a plan.",
      }),
      price: z.union([z.literal("").transform(() => null), moneySchema(currency, { allowZero: true })]),
      interval: z.union([z.literal("").transform(() => null), intervalSchema]),
      intervalCount: z.union([z.literal("").transform(() => null), intervalCountSchema]),
      quantity: quantitySchema,
      effectiveDate: daySchema("the date the change takes effect"),
    })
    .superRefine((values, ctx) => {
      if (values.planId !== CUSTOM_PRICE) return;
      if (values.price === null) {
        ctx.addIssue({ code: "custom", path: ["price"], message: "Enter the custom price." });
      }
      if (values.interval === null || values.intervalCount === null) {
        ctx.addIssue({ code: "custom", path: ["interval"], message: "Choose how often it bills." });
      } else {
        checkIntervalCount(values.interval, values.intervalCount, ctx);
      }
    });
}

export const CANCEL_SUBSCRIPTION_FIELDS = ["subscriptionId", "effectiveDate"] as const;

export function cancelSubscriptionSchema() {
  return z.object({
    subscriptionId: idSchema,
    effectiveDate: daySchema("the date it ends"),
  });
}

export const CORRECT_SUBSCRIPTION_FIELDS = [
  "subscriptionId",
  "startDate",
  "price",
  "quantity",
  "status",
] as const;

/** Correct: rewrites the current terms in place, for fixing a data-entry mistake. */
export function correctSubscriptionSchema(currency: string) {
  return z.object({
    subscriptionId: idSchema,
    startDate: daySchema("the start date"),
    price: moneySchema(currency, { allowZero: true }),
    quantity: quantitySchema,
    status: z.enum(LIVE_STATUSES, { error: "Choose a status." }),
  });
}

export const SUBSCRIPTION_ID_FIELDS = ["subscriptionId"] as const;

export function subscriptionIdSchema() {
  return z.object({ subscriptionId: idSchema });
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const RECORD_INVOICE_FIELDS = [
  "customerId",
  "subscriptionId",
  "amount",
  "issuedDate",
  "dueDate",
  "status",
  "paidDate",
] as const;

export function recordInvoiceSchema(currency: string) {
  return z
    .object({
      customerId: z.string().regex(ID_PATTERN, { error: "Choose a customer." }),
      subscriptionId: z.union([z.literal("").transform(() => null), idSchema]),
      amount: moneySchema(currency, { allowZero: false }),
      issuedDate: daySchema("the issue date"),
      dueDate: optionalDaySchema("a due date"),
      status: z.enum(RECORD_STATUSES, { error: "Choose a status." }),
      paidDate: optionalDaySchema("the date it was paid", "today"),
    })
    .superRefine((values, ctx) => {
      if (values.dueDate !== null && values.dueDate < values.issuedDate) {
        ctx.addIssue({ code: "custom", path: ["dueDate"], message: "The due date can't be before the issue date." });
      }
      if (values.status === "PAID") {
        if (values.paidDate === null) {
          ctx.addIssue({ code: "custom", path: ["paidDate"], message: "Enter the date it was paid." });
        } else if (values.paidDate < values.issuedDate) {
          ctx.addIssue({ code: "custom", path: ["paidDate"], message: "It can't be paid before it was issued." });
        }
      }
    });
}

export const MARK_PAID_FIELDS = ["invoiceId", "paidDate"] as const;

export function markPaidSchema() {
  return z.object({ invoiceId: idSchema, paidDate: daySchema("the date it was paid", "today") });
}

export const INVOICE_ID_FIELDS = ["invoiceId"] as const;

export function invoiceIdSchema() {
  return z.object({ invoiceId: idSchema });
}

// ---------------------------------------------------------------------------
// Options the dialogs are given — serializable, no Date or Decimal
// ---------------------------------------------------------------------------

export interface PlanOption {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
}

export interface CustomerOption {
  readonly id: string;
  readonly name: string;
}

/** A customer's current subscription, for "which subscription is this invoice for?". */
export interface SubscriptionOption {
  readonly id: string;
  readonly customerId: string;
  readonly label: string;
}

/** The price input's starting text for a stored amount. */
export function priceInput(minor: number, currency: string): string {
  return minorToInput(minor, currency);
}
