// The "Add subscription" form's rules and result shape — shared by the client
// dialog (instant feedback, price pre-fill) and the `addSubscription` Server
// Action (the check that counts), so the two can never disagree.
//
// A plain module: a `"use server"` module cannot export a schema, a type or a
// constant (see lib/notifications.ts), and the client imports this directly.
import type { BillingInterval, PlanTier, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

export const PLAN_TIERS = ["FREE", "STARTER", "PRO", "ENTERPRISE"] as const satisfies readonly PlanTier[];
export const BILLING_INTERVALS = ["MONTHLY", "YEARLY"] as const satisfies readonly BillingInterval[];

/**
 * The statuses a NEW subscription can start in. CANCELED is left out on purpose:
 * cancellation is an event with its own `canceledAt` / `endedAt`, not a starting
 * state, and a row born CANCELED with no end date would still count as live MRR
 * (activity is decided by dates — see lib/metrics.ts).
 */
export const START_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const satisfies readonly SubscriptionStatus[];

/** Largest accepted price: $9,999,999.99. */
const PRICE_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

/** Today's date in UTC as `YYYY-MM-DD` — the day boundary every metric uses. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "49" / "49.5" / "49.00" -> 4900 / 4950 / 4900, in integer arithmetic (no float rounding). */
function priceToCents(price: string): number {
  const [whole, fraction = ""] = price.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Cents -> the plain "49.00" the price input holds. */
export function centsToPriceInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const subscriptionSchema = z
  .object({
    tier: z.enum(PLAN_TIERS, { error: "Choose a plan." }),
    interval: z.enum(BILLING_INTERVALS, { error: "Choose a billing interval." }),
    status: z.enum(START_STATUSES, { error: "Choose a status." }),
    price: z
      .string({ error: "Enter a price." })
      .trim()
      .regex(PRICE_PATTERN, { error: "Enter a price like 49 or 49.00." })
      .transform(priceToCents),
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
  .refine((values) => values.tier !== "FREE" || values.price === 0, {
    path: ["price"],
    error: "The Free plan is always $0.",
  });

export type SubscriptionField = "tier" | "interval" | "status" | "price" | "startDate";

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
  // `safeParse` types its error by the schema's OUTPUT (price is cents there).
  error: z.ZodError<z.output<typeof subscriptionSchema>>,
): SubscriptionFieldErrors {
  const { fieldErrors } = z.flattenError(error);
  return {
    tier: fieldErrors.tier?.[0],
    interval: fieldErrors.interval?.[0],
    status: fieldErrors.status?.[0],
    price: fieldErrors.price?.[0],
    startDate: fieldErrors.startDate?.[0],
  };
}
