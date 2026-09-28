// The "Add subscription" form's rules and result shape — shared by the client
// dialog (instant feedback, price pre-fill) and the `addSubscription` Server
// Action (the check that counts), so the two can never disagree.
//
// A plain module: a `"use server"` module cannot export a schema, a type or a
// constant (see lib/notifications.ts), and the client imports this directly.
import type { BillingInterval, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

/**
 * The statuses a NEW subscription can start in. CANCELED is left out on purpose:
 * cancellation is an event with its own `canceledAt` / `endedAt`, not a starting
 * state, and a row born CANCELED with no end date would still count as live MRR
 * (activity is decided by dates — see lib/metrics.ts).
 */
export const START_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const satisfies readonly SubscriptionStatus[];

/** Picker value meaning "create a new customer from the name field". */
export const NEW_CUSTOMER = "__new_customer__";
/** Picker value meaning "no plan — a custom price and interval". */
export const CUSTOM_PRICE = "__custom_price__";

/** Intervals offered for a custom price. A plan brings its own. */
export const BILLING_OPTIONS = [
  { key: "MONTH_1", label: "Monthly", interval: "MONTH", intervalCount: 1 },
  { key: "MONTH_3", label: "Quarterly", interval: "MONTH", intervalCount: 3 },
  { key: "YEAR_1", label: "Yearly", interval: "YEAR", intervalCount: 1 },
] as const satisfies readonly {
  key: string;
  label: string;
  interval: BillingInterval;
  intervalCount: number;
}[];

export type BillingKey = (typeof BILLING_OPTIONS)[number]["key"];
const BILLING_KEYS = BILLING_OPTIONS.map((option) => option.key) as [BillingKey, ...BillingKey[]];

export function billingOption(key: BillingKey): (typeof BILLING_OPTIONS)[number] {
  const option = BILLING_OPTIONS.find((candidate) => candidate.key === key);
  if (option === undefined) throw new Error(`Unknown billing option "${key}"`);
  return option;
}

/** cuid-shaped ids: nothing exotic reaches a WHERE clause. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Largest accepted price: 9,999,999.99. */
const PRICE_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

export const CUSTOMER_NAME_MAX = 100;

/** Today's date in UTC as `YYYY-MM-DD` — the day boundary every metric uses. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "49" / "49.5" / "49.00" -> 4900 / 4950 / 4900, in integer arithmetic (no float rounding). */
export function priceToCents(price: string): number {
  const [whole, fraction = ""] = price.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Cents -> the plain "49.00" the price input holds. */
export function centsToPriceInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** FormData gives `null` for a field that was not rendered; treat it as empty. */
const text = z.preprocess((value) => value ?? "", z.string());

export const subscriptionSchema = z
  .object({
    customerId: text.refine((value) => value === NEW_CUSTOMER || ID_PATTERN.test(value), {
      error: "Choose a customer.",
    }),
    newCustomerName: text.pipe(
      z.string().trim().max(CUSTOMER_NAME_MAX, { error: `Use at most ${CUSTOMER_NAME_MAX} characters.` }),
    ),
    planId: text.refine((value) => value === CUSTOM_PRICE || ID_PATTERN.test(value), {
      error: "Choose a plan.",
    }),
    // Empty means "the plan's price"; required for a custom price (below).
    price: text.pipe(
      z
        .string()
        .trim()
        .refine((value) => value === "" || PRICE_PATTERN.test(value), {
          error: "Enter a price like 49 or 49.00.",
        }),
    ),
    billing: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.enum(BILLING_KEYS, { error: "Choose how often it bills." }).optional(),
    ),
    status: z.enum(START_STATUSES, { error: "Choose a status." }),
    startDate: z
      .string({ error: "Choose a start date." })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose a start date." })
      .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
        error: "Choose a start date.",
      })
      // Stored snapshots for past days are final (the daily job only writes new
      // days), so a backdated subscription would move live MRR while the trend
      // history stayed put. Today or later keeps the two in agreement.
      .refine((value) => value >= todayUtc(), { error: "Start today or later (UTC)." }),
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
      if (values.price === "") {
        ctx.addIssue({ code: "custom", path: ["price"], message: "Enter the custom price." });
      }
      if (values.billing === undefined) {
        ctx.addIssue({ code: "custom", path: ["billing"], message: "Choose how often it bills." });
      }
    }
  });

export type SubscriptionField =
  | "customerId"
  | "newCustomerName"
  | "planId"
  | "price"
  | "billing"
  | "status"
  | "startDate";

export type SubscriptionFieldErrors = Partial<Record<SubscriptionField, string>>;

export interface SubscriptionFormState {
  readonly status: "idle" | "success" | "error";
  /** A form-level message (authorization, stale page), or null. */
  readonly message: string | null;
  readonly fieldErrors: SubscriptionFieldErrors;
}

export const IDLE_SUBSCRIPTION_FORM: SubscriptionFormState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

/** The first message for each field, from a failed parse of `subscriptionSchema`. */
export function subscriptionFieldErrors(
  error: z.ZodError<z.output<typeof subscriptionSchema>>,
): SubscriptionFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    customerId: fieldErrors.customerId?.[0],
    newCustomerName: fieldErrors.newCustomerName?.[0],
    planId: fieldErrors.planId?.[0],
    price: fieldErrors.price?.[0],
    billing: fieldErrors.billing?.[0],
    status: fieldErrors.status?.[0],
    startDate: fieldErrors.startDate?.[0],
  };
}

/** A plan as the dialog needs it — serializable, no Decimal or Date. */
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
