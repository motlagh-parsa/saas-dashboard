import "server-only";

import { Prisma } from "@prisma/client";
import type { InvoiceStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * SaaS metrics query layer.
 *
 * Contract for every function in this file:
 *   - Tenant-scoped. `organizationId` is required and is applied to EVERY table
 *     touched by the query, including joined Customer and Plan rows. A missing
 *     tenant filter is a security bug, not a perf bug.
 *   - Money is INTEGER MINOR UNITS in the workspace's single currency
 *     (`Organization.currency`). No floats, no formatting, no symbols.
 *   - Aggregation happens in Postgres. Nothing here pulls a table into JS to
 *     reduce it.
 *   - Raw SQL is always `Prisma.sql` tagged templates; every value is a bind
 *     parameter. Nothing is string-interpolated into SQL.
 *
 * ---------------------------------------------------------------------------
 * Definitions — shared with lib/snapshot-formula.ts, which states them for the
 * daily rollup. Keep the two in step.
 * ---------------------------------------------------------------------------
 *   Monthly MRR of a subscription = amountCents × quantity ÷ months in its
 *     interval (intervalCount for MONTH, 12 × intervalCount for YEAR). Summed
 *     unrounded and rounded ONCE, at the end of each sum — see `cents()`.
 *   Live at t:  startedAt <= t AND (endedAt IS NULL OR endedAt > t). Decided by
 *     DATES, never by `status`: a segment is inactive ON its `endedAt` instant.
 *   Active customer at t: has at least one live subscription with MRR > 0.
 *     Amounts are CHECK-constrained >= 0 and quantity >= 1, so "the customer's
 *     MRR is > 0" and "one of their live subscriptions bills > 0" are the same.
 *   Between two instants a and b, for each customer:
 *     new          MRR(a) = 0, MRR(b) > 0, never active before a
 *     reactivation MRR(a) = 0, MRR(b) > 0, active at some point before a
 *     expansion    MRR(a) > 0, MRR(b) > MRR(a)
 *     contraction  MRR(a) > 0, 0 < MRR(b) < MRR(a)
 *     churn        MRR(a) > 0, MRR(b) = 0
 *   which makes  ending = starting + new + reactivation + expansion − contraction − churn.
 *   A customer is a `Customer` row, so a plan change (one segment ends, another
 *   starts for the same customer) is expansion or contraction by construction.
 *   `previousSubscriptionId` records the hand-off but no metric depends on it.
 *
 * Period boundaries: a `ResolvedPeriod` is `{ start, end }`. STATE (MRR, active
 * counts) is measured AS OF `start` and `end`; retention compares the two.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MONTHS_PER_YEAR = 12;

/** Default and hard cap for the month-bucketed series, in calendar months. */
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 60;

/** How a subscription with no plan (custom price) is labelled in plan breakdowns. */
export const CUSTOM_PLAN_LABEL = "Custom";

// ---------------------------------------------------------------------------
// Period types
// ---------------------------------------------------------------------------

export type PeriodPreset =
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "month_to_date"
  | "last_month"
  | "last_3_months"
  | "last_12_months";

/**
 * Discriminated period selector.
 *  - `preset`: a named window, anchored at `asOf` (defaults to now).
 *  - `range`: an explicit `[start, end]` instant pair.
 */
export type Period =
  | { readonly kind: "preset"; readonly preset: PeriodPreset; readonly asOf?: Date }
  | { readonly kind: "range"; readonly start: Date; readonly end: Date };

/** A period reduced to two concrete UTC instants. */
export interface ResolvedPeriod {
  readonly start: Date;
  readonly end: Date;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface MetricComparison<TValue> {
  readonly current: TValue;
  readonly previous: TValue;
  /**
   * Period-over-period change as a FRACTION (0.12 = +12%, -0.03 = -3%).
   * `null` when `previous` is 0 or either side is unavailable — a jump from 0 has
   * no defined percentage change.
   */
  readonly changePct: number | null;
}

export interface RateComparison extends MetricComparison<number | null> {
  /**
   * Percentage-POINT delta of the rate (current - previous), e.g. 0.02 = +2pp.
   * `null` when either side is null. Preferred over `changePct` for a rate.
   */
  readonly changePoints: number | null;
}

export interface MetricsSummary {
  readonly organizationId: string;
  readonly period: ResolvedPeriod;
  readonly previousPeriod: ResolvedPeriod;
  /** The workspace's ISO 4217 reporting currency. */
  readonly currency: string;
  /** MRR measured as of each period's `end`. */
  readonly mrrCents: MetricComparison<number>;
  /** ARR measured as of each period's `end`. Always `mrrCents * 12`. */
  readonly arrCents: MetricComparison<number>;
  /** Customers with MRR > 0 as of each period's `end`. */
  readonly activeCustomers: MetricComparison<number>;
  /** Live subscriptions as of each period's `end` (a customer can hold several). */
  readonly activeSubscriptions: MetricComparison<number>;
  /**
   * CUSTOMER (logo) churn: of the customers active at the period start, the
   * fraction not active at its end. `null` when none were active at the start.
   */
  readonly customerChurnRate: RateComparison;
  /**
   * REVENUE churn: the starting MRR of those churned customers, as a fraction of
   * all starting MRR. Contraction is not churn and is not in this figure.
   */
  readonly revenueChurnRate: RateComparison;
}

export interface NetRevenueRetentionResult {
  readonly organizationId: string;
  readonly period: ResolvedPeriod;
  /** Customers active (MRR > 0) at `period.start` — the cohort NRR follows. */
  readonly cohortCustomers: number;
  /** Cohort members not active at `period.end`. */
  readonly churnedCustomers: number;
  /** Cohort MRR as of `period.start`. */
  readonly startingMRRCents: number;
  /** The same cohort's MRR as of `period.end` (new customers excluded). */
  readonly endingMRRCents: number;
  readonly expansionMRRCents: number;
  /** Positive magnitude. */
  readonly contractionMRRCents: number;
  /** Positive magnitude: the starting MRR of cohort members who left. */
  readonly churnedMRRCents: number;
  /**
   * (starting + expansion − contraction − churned) / starting, as a FRACTION
   * (1.12 = 112%). `null` when the cohort is empty — undefined, not 0.
   */
  readonly nrr: number | null;
}

export interface PlanMixEntry {
  /** `null` for custom-priced subscriptions, labelled `CUSTOM_PLAN_LABEL`. */
  readonly planId: string | null;
  readonly name: string;
  readonly mrrCents: number;
  readonly subscriptions: number;
}

export interface PlanMixResult {
  readonly organizationId: string;
  readonly asOf: Date;
  /** Rounded once over every live subscription — equals the headline MRR. */
  readonly totalMRRCents: number;
  readonly totalSubscriptions: number;
  /** Highest MRR first. */
  readonly byPlan: readonly PlanMixEntry[];
  /** Live subscriptions in PAST_DUE — still billing, still counted in MRR. */
  readonly pastDueSubscriptions: number;
}

export interface MRRTrendPoint {
  /** UTC calendar month, `YYYY-MM`. */
  readonly month: string;
  /** UTC date of the snapshot the point-in-time values were read from, `YYYY-MM-DD`. */
  readonly asOfDate: string;
  /** Month-end MRR, from the LAST snapshot of the month. */
  readonly mrrCents: number;
  readonly activeCustomers: number;
  readonly activeSubs: number;
  /** Flows: summed across every snapshot in the month. */
  readonly newCustomers: number;
  readonly churnedCustomers: number;
}

export interface CustomerActivitySummary {
  readonly period: ResolvedPeriod;
  readonly previousPeriod: ResolvedPeriod;
  /**
   * Active customers as of each period's `end`: the latest snapshot on or before
   * that UTC day. `null` when the workspace has no snapshot that early.
   */
  readonly activeCustomers: MetricComparison<number | null>;
  /** New customers over each period: the sum of daily `newCustomers` in (start, end]. */
  readonly newCustomers: MetricComparison<number>;
  /** Churned customers over each period, summed the same way. */
  readonly churnedCustomers: MetricComparison<number>;
  /**
   * `YYYY-MM-DD` of the snapshot `activeCustomers.current` comes from, or null.
   * Earlier than `period.end` whenever the daily snapshot job has not caught up.
   */
  readonly asOfDate: string | null;
}

/** One calendar month of the revenue bridge, attributed per CUSTOMER. */
export interface RevenueMovementPoint {
  /** UTC calendar month `YYYY-MM` — the month the movement happened IN. */
  readonly month: string;
  /** Opening boundary — MRR is measured as of this instant. */
  readonly periodStart: Date;
  /** Closing boundary. `periodStart` + 1 month, except for a partial trailing month. */
  readonly periodEnd: Date;
  /** False for the in-progress month, whose closing boundary is `asOf`. */
  readonly isComplete: boolean;
  readonly startingMRRCents: number;
  readonly endingMRRCents: number;
  /** Customers billing for the first time ever. */
  readonly newMRRCents: number;
  /** Customers who had billed before, stopped, and came back. */
  readonly reactivationMRRCents: number;
  readonly expansionMRRCents: number;
  /** Positive magnitude. */
  readonly contractionMRRCents: number;
  /** Positive magnitude. */
  readonly churnedMRRCents: number;
  /** Customers with MRR > 0 at `periodStart` — the NRR/GRR denominator's owners. */
  readonly payingCustomersAtStart: number;
  readonly newCustomers: number;
  readonly reactivatedCustomers: number;
  readonly churnedCustomers: number;
  /** `(starting + expansion − contraction − churned) / starting`; `null` at 0 starting MRR. */
  readonly nrr: number | null;
  /** `(starting − contraction − churned) / starting`; never above 1. */
  readonly grr: number | null;
}

/** One calendar month of churn, measured the way `getMetricsSummary` measures it. */
export interface ChurnRateTrendPoint {
  /** UTC calendar month `YYYY-MM`. */
  readonly month: string;
  readonly period: ResolvedPeriod;
  readonly isComplete: boolean;
  /** Customers active at the month's open. */
  readonly customersAtStart: number;
  /** Of those, the ones not active at its close. */
  readonly churnedCustomers: number;
  /** CUSTOMER (logo) churn rate, a FRACTION; `null` when no customer was active at the open. */
  readonly rate: number | null;
  readonly startingMRRCents: number;
  readonly churnedMRRCents: number;
  /** REVENUE churn rate, a FRACTION; `null` when nothing was billing at the open. */
  readonly revenueRate: number | null;
}

/** Keyset pagination cursor. Matches the `[issuedAt desc, id desc]` ordering. */
export interface InvoiceCursor {
  readonly issuedAt: Date;
  readonly id: string;
}

export interface InvoiceListOptions {
  /** Filters on `issuedAt`, on the `(start, end]` event convention. */
  readonly period?: Period;
  /** Empty or omitted means every status. */
  readonly statuses?: readonly InvoiceStatus[];
  /** Clamped to [1, 100]. */
  readonly limit?: number;
  readonly cursor?: InvoiceCursor;
}

export interface RecentInvoice {
  readonly id: string;
  readonly amountCents: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly customer: { readonly id: string; readonly name: string };
  /**
   * The plan the invoice's subscription was on, `CUSTOM_PLAN_LABEL` for a
   * custom-priced subscription, `null` for a one-off charge.
   */
  readonly planName: string | null;
}

export interface InvoiceListResult {
  readonly invoices: RecentInvoice[];
  /** `null` when this is the last page. Pass it back as `options.cursor`. */
  readonly nextCursor: InvoiceCursor | null;
}

export interface InvoiceStatusTotal {
  readonly status: InvoiceStatus;
  readonly count: number;
  readonly amountCents: number;
}

export interface InvoiceTotals {
  readonly organizationId: string;
  readonly period: ResolvedPeriod;
  readonly currency: string;
  /** Cash that ARRIVED in `(start, end]`, bucketed by `paidAt`. A flow. */
  readonly collectedCents: number;
  /** Every OPEN invoice issued at or before `period.end`. A stock, not a flow. */
  readonly outstandingCents: number;
  /** Face value of everything issued in `(start, end]`, whatever its status. */
  readonly issuedCents: number;
  /** Statuses present among invoices issued in the period, largest first. */
  readonly byStatus: readonly InvoiceStatusTotal[];
}

/**
 * Where a customer stands at `asOf`:
 *   - `active`   — MRR > 0.
 *   - `churned`  — not active, but was at some point before.
 *   - `inactive` — never billed anything yet (no subscription, only free ones,
 *                  or one that has not started).
 */
export type CustomerState = "active" | "churned" | "inactive";

export interface CustomerListRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly state: CustomerState;
  /** A live subscription is PAST_DUE — still billing, but money is owed. */
  readonly pastDue: boolean;
  readonly mrrCents: number;
  /** Plan names of the live subscriptions, comma-joined; `null` when nothing is live. */
  readonly livePlans: string | null;
  /** The first instant the customer was ever active. */
  readonly customerSince: Date | null;
  /** When the last paying subscription ended. Only set when `state` is "churned". */
  readonly churnedAt: Date | null;
}

export interface CustomerListResult {
  readonly organizationId: string;
  readonly asOf: Date;
  readonly currency: string;
  /** Highest MRR first, then by name. Archived customers are excluded. */
  readonly customers: readonly CustomerListRow[];
  readonly activeCount: number;
  readonly churnedCount: number;
  /** Mean MRR over ACTIVE customers only (ARPA). */
  readonly averageMRRCents: number;
}

// ---------------------------------------------------------------------------
// UTC date helpers
// ---------------------------------------------------------------------------

function startOfMonthUTC(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/** Calendar-month arithmetic that clamps the day (Mar 31 - 1 month => Feb 28/29). */
function addMonthsUTC(value: Date, months: number): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(value.getUTCDate(), lastDayOfTarget),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
}

function addDaysUTC(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

/**
 * Clamp a caller-supplied month count to `[0, MAX_TREND_MONTHS]`.
 *
 * `NaN` is reachable from a URL (`Number(searchParams.get("months"))`) and must
 * be caught BEFORE the clamp — `Math.max(NaN, 0)` is `NaN`, which Postgres rejects
 * as an integer bind: a 500, not an empty chart.
 */
function clampMonths(months: number): number {
  const requested = Number.isNaN(months) ? DEFAULT_TREND_MONTHS : Math.trunc(months);
  return Math.min(Math.max(requested, 0), MAX_TREND_MONTHS);
}

/** The boundary instants a month-bucketed series is measured at. */
interface MonthWindow {
  /** Opening boundary of the earliest month returned. */
  readonly firstBoundary: Date;
  /** Start of the calendar month containing `asOf`. */
  readonly lastMonthStart: Date;
  readonly asOf: Date;
}

/**
 * `span` months of boundaries ending at `asOf`. When `asOf` is mid-month a final
 * boundary at `asOf` itself closes the in-progress month.
 */
function monthWindow(span: number, asOf: Date): MonthWindow {
  const lastMonthStart = startOfMonthUTC(asOf);
  return { firstBoundary: addMonthsUTC(lastMonthStart, -(span - 1)), lastMonthStart, asOf };
}

/**
 * The month boundaries of a `MonthWindow`, as a one-column `boundary` relation.
 * Month starts partition time exactly, so an event lands in one month only.
 */
function monthBoundariesCte(window: MonthWindow): Prisma.Sql {
  return Prisma.sql`
    boundaries AS (
      SELECT generate_series(
               ${ts(window.firstBoundary)},
               ${ts(window.lastMonthStart)},
               INTERVAL '1 month') AS boundary
      UNION
      SELECT ${ts(window.asOf)}
      WHERE ${ts(window.asOf)} > ${ts(window.lastMonthStart)}
    )`;
}

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

/** Number of calendar months a preset spans, or `null` if it is day-based. */
function presetMonthSpan(preset: PeriodPreset): number | null {
  switch (preset) {
    case "month_to_date":
    case "last_month":
      return 1;
    case "last_3_months":
      return 3;
    case "last_12_months":
      return 12;
    default:
      return null;
  }
}

export function resolvePeriod(period: Period): ResolvedPeriod {
  if (period.kind === "range") {
    return { start: period.start, end: period.end };
  }

  const asOf = period.asOf ?? new Date();

  switch (period.preset) {
    case "last_7_days":
      return { start: addDaysUTC(asOf, -7), end: asOf };
    case "last_30_days":
      return { start: addDaysUTC(asOf, -30), end: asOf };
    case "last_90_days":
      return { start: addDaysUTC(asOf, -90), end: asOf };
    case "month_to_date":
      return { start: startOfMonthUTC(asOf), end: asOf };
    case "last_month":
      return { start: startOfMonthUTC(addMonthsUTC(asOf, -1)), end: startOfMonthUTC(asOf) };
    case "last_3_months":
      return { start: addMonthsUTC(asOf, -3), end: asOf };
    case "last_12_months":
      return { start: addMonthsUTC(asOf, -MONTHS_PER_YEAR), end: asOf };
  }
}

/**
 * The comparison window preceding an ALREADY-RESOLVED period. Resolve once:
 * `resolvePeriod` reads the clock for a preset without `asOf`, so resolving twice
 * yields two different "now"s and overlapping windows.
 */
function previousOfResolved(period: Period, current: ResolvedPeriod): ResolvedPeriod {
  if (period.kind === "preset") {
    const span = presetMonthSpan(period.preset);
    if (span !== null) {
      return {
        start: addMonthsUTC(current.start, -span),
        end: addMonthsUTC(current.end, -span),
      };
    }
  }

  const durationMs = current.end.getTime() - current.start.getTime();
  return { start: new Date(current.start.getTime() - durationMs), end: current.start };
}

/**
 * The comparison window immediately preceding `period`. Calendar presets shift by
 * whole months; day-based presets and explicit ranges shift by their own duration.
 */
export function previousPeriod(period: Period): ResolvedPeriod {
  return previousOfResolved(period, resolvePeriod(period));
}

// ---------------------------------------------------------------------------
// Raw-SQL primitives
// ---------------------------------------------------------------------------

type NumericLike = number | bigint | string | null;

/** Postgres hands int8/numeric back as BigInt or string depending on the type. */
function toNumber(value: NumericLike): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Bind a JS Date as a Postgres `timestamp` (no time zone) carrying its UTC
 * wall-clock — Prisma stores `DateTime` as `TIMESTAMP(3)` holding the UTC instant.
 */
function ts(value: Date): Prisma.Sql {
  return Prisma.sql`${value.toISOString()}::timestamp`;
}

/**
 * Aliases a `Subscription` row carries in this file's SQL. A closed union checked
 * at compile time: `Prisma.raw` is the only way to put an identifier into a query,
 * so no caller-supplied value can ever reach it.
 */
type SubscriptionAlias = "s" | "x";

/**
 * A subscription's monthly-normalized MRR, UNROUNDED (numeric):
 * amountCents × quantity ÷ (intervalCount, or 12 × intervalCount for YEAR).
 * Every derived figure runs through this one expression.
 */
function monthlyExact(alias: SubscriptionAlias): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}."amountCents"::numeric * ${a}."quantity"
    / ((CASE WHEN ${a}."interval" = 'YEAR'::"BillingInterval" THEN 12 ELSE 1 END) * ${a}."intervalCount"))`;
}

/**
 * Round a SUM of `monthlyExact` terms to whole cents — once, at the end.
 *
 * Postgres rounds each numeric quotient to ~20 decimals, so a total whose exact
 * value is k + ½ can come out as k + 0.4999…9 and round the wrong way. Rounding
 * to 10 decimals first absorbs that error (it is ~1e-20 per term) while leaving
 * any genuine distance from a half untouched (at least 1 / (2 × interval months),
 * far above 1e-10). The result equals exact rational rounding, which is what
 * lib/snapshot-formula.ts computes — so live MRR and snapshot MRR agree to the cent.
 */
function cents(sum: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ROUND(ROUND(COALESCE(${sum}, 0), 10))::bigint`;
}

/** Live-as-of predicate. A segment is inactive ON its `endedAt`. */
function liveAsOf(alias: SubscriptionAlias, instant: Prisma.Sql): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}."startedAt" <= ${instant} AND (${a}."endedAt" IS NULL OR ${a}."endedAt" > ${instant}))`;
}

/**
 * Two CTEs, comma-joined, for the month-bucketed series:
 *   subs       — the tenant's subscriptions that can be live at any boundary of
 *                the window, with their exact MRR;
 *   first_paid — each customer's first paying instant over ALL history, which is
 *                what tells a brand-new customer from a returning one. It must not
 *                be pruned to the window: a customer who churned before it started
 *                would otherwise look new when they return.
 */
function customerSeriesCtes(organizationId: string, window: MonthWindow): Prisma.Sql {
  return Prisma.sql`
    subs AS (
      SELECT x."customerId" AS customer_id, x."startedAt", x."endedAt",
             ${monthlyExact("x")} AS mrr
      FROM "Subscription" x
      WHERE x."organizationId" = ${organizationId}
        AND x."startedAt" <= ${ts(window.asOf)}
        AND (x."endedAt" IS NULL OR x."endedAt" > ${ts(window.firstBoundary)})
    ),
    first_paid AS (
      SELECT x."customerId" AS customer_id, MIN(x."startedAt") AS first_paid_at
      FROM "Subscription" x
      WHERE x."organizationId" = ${organizationId}
        AND ${monthlyExact("x")} > 0
        AND (x."endedAt" IS NULL OR x."endedAt" > x."startedAt")
      GROUP BY x."customerId"
    )`;
}

/** The live predicate for the `subs` CTE's rows (aliased `s`) at a boundary column. */
function subsLiveAt(boundary: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(s."startedAt" <= ${boundary} AND (s."endedAt" IS NULL OR s."endedAt" > ${boundary}))`;
}

interface MRRStateRow {
  mrr_cents: NumericLike;
  subscriptions: NumericLike;
  customers: NumericLike;
}

/** MRR, live subscriptions and active customers as of an instant. */
function mrrStateQuery(
  organizationId: string,
  asOf: Date,
): Prisma.PrismaPromise<MRRStateRow[]> {
  return prisma.$queryRaw<MRRStateRow[]>(Prisma.sql`
    SELECT
      ${cents(Prisma.sql`SUM(${monthlyExact("s")})`)} AS mrr_cents,
      COUNT(*)::int AS subscriptions,
      COUNT(DISTINCT s."customerId") FILTER (WHERE ${monthlyExact("s")} > 0)::int AS customers
    FROM "Subscription" s
    WHERE s."organizationId" = ${organizationId}
      AND ${liveAsOf("s", ts(asOf))}
  `);
}

interface CohortRow {
  customers_at_start: NumericLike;
  churned_customers: NumericLike;
  starting_mrr_cents: NumericLike;
  ending_mrr_cents: NumericLike;
  expansion_mrr_cents: NumericLike;
  contraction_mrr_cents: NumericLike;
  churned_mrr_cents: NumericLike;
}

/**
 * The retention cohort of a period, in one pass: every customer's MRR at the
 * period start and at its end, then the customers active at the start followed to
 * the end. This one query yields NRR's arithmetic, customer churn and revenue
 * churn, so the three can never disagree about who was in the cohort.
 *
 * Only subscriptions that can be live at either instant are read: live at start
 * or at end implies `startedAt <= end AND (endedAt IS NULL OR endedAt > start)`.
 */
function cohortQuery(
  organizationId: string,
  period: ResolvedPeriod,
): Prisma.PrismaPromise<CohortRow[]> {
  const startTs = ts(period.start);
  const endTs = ts(period.end);
  return prisma.$queryRaw<CohortRow[]>(Prisma.sql`
    WITH per_customer AS (
      SELECT
        s."customerId" AS customer_id,
        COALESCE(SUM(${monthlyExact("s")}) FILTER (WHERE ${liveAsOf("s", startTs)}), 0) AS start_mrr,
        COALESCE(SUM(${monthlyExact("s")}) FILTER (WHERE ${liveAsOf("s", endTs)}), 0) AS end_mrr
      FROM "Subscription" s
      WHERE s."organizationId" = ${organizationId}
        AND s."startedAt" <= ${endTs}
        AND (s."endedAt" IS NULL OR s."endedAt" > ${startTs})
      GROUP BY s."customerId"
    )
    SELECT
      COUNT(*) FILTER (WHERE start_mrr > 0)::int                        AS customers_at_start,
      COUNT(*) FILTER (WHERE start_mrr > 0 AND end_mrr = 0)::int        AS churned_customers,
      ${cents(Prisma.sql`SUM(start_mrr) FILTER (WHERE start_mrr > 0)`)} AS starting_mrr_cents,
      ${cents(Prisma.sql`SUM(end_mrr) FILTER (WHERE start_mrr > 0)`)}   AS ending_mrr_cents,
      ${cents(Prisma.sql`SUM(end_mrr - start_mrr) FILTER (WHERE start_mrr > 0 AND end_mrr > start_mrr)`)}
        AS expansion_mrr_cents,
      ${cents(Prisma.sql`SUM(start_mrr - end_mrr) FILTER (WHERE start_mrr > 0 AND end_mrr > 0 AND end_mrr < start_mrr)`)}
        AS contraction_mrr_cents,
      ${cents(Prisma.sql`SUM(start_mrr) FILTER (WHERE start_mrr > 0 AND end_mrr = 0)`)}
        AS churned_mrr_cents
    FROM per_customer
  `);
}

interface CohortFigures {
  readonly customersAtStart: number;
  readonly churnedCustomers: number;
  readonly startingMRRCents: number;
  readonly endingMRRCents: number;
  readonly expansionMRRCents: number;
  readonly contractionMRRCents: number;
  readonly churnedMRRCents: number;
}

function cohortFigures(row: CohortRow | undefined): CohortFigures {
  return {
    customersAtStart: toNumber(row?.customers_at_start ?? 0),
    churnedCustomers: toNumber(row?.churned_customers ?? 0),
    startingMRRCents: toNumber(row?.starting_mrr_cents ?? 0),
    endingMRRCents: toNumber(row?.ending_mrr_cents ?? 0),
    expansionMRRCents: toNumber(row?.expansion_mrr_cents ?? 0),
    contractionMRRCents: toNumber(row?.contraction_mrr_cents ?? 0),
    churnedMRRCents: toNumber(row?.churned_mrr_cents ?? 0),
  };
}

function customerChurnOf(figures: CohortFigures): number | null {
  return figures.customersAtStart === 0 ? null : figures.churnedCustomers / figures.customersAtStart;
}

function revenueChurnOf(figures: CohortFigures): number | null {
  return figures.startingMRRCents === 0 ? null : figures.churnedMRRCents / figures.startingMRRCents;
}

/** (current - previous) / previous as a fraction; null when previous is 0. */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

function rateComparison(current: number | null, previous: number | null): RateComparison {
  return {
    current,
    previous,
    changePct: current === null || previous === null ? null : percentChange(current, previous),
    changePoints: current === null || previous === null ? null : current - previous,
  };
}

function currencyQuery(organizationId: string) {
  return prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { currency: true },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The workspace's ISO 4217 reporting currency. */
export async function getOrganizationCurrency(organizationId: string): Promise<string> {
  const organization = await currencyQuery(organizationId);
  return organization.currency;
}

/**
 * Headline KPIs with period-over-period comparison.
 *
 * MRR / ARR / active counts are STATE as of each period's `end`; churn is
 * measured over each period from its opening cohort. Everything is read in one
 * REPEATABLE READ transaction so every figure comes from the same database
 * snapshot — at READ COMMITTED a write between two statements would compare two
 * different states of the world. All read-only, so it cannot raise a
 * serialization failure.
 */
export async function getMetricsSummary(
  organizationId: string,
  period: Period = { kind: "preset", preset: "last_30_days" },
): Promise<MetricsSummary> {
  const current = resolvePeriod(period);
  const previous = previousOfResolved(period, current);

  const [organization, currentState, previousState, currentCohort, previousCohort] =
    await prisma.$transaction(
      [
        currencyQuery(organizationId),
        mrrStateQuery(organizationId, current.end),
        mrrStateQuery(organizationId, previous.end),
        cohortQuery(organizationId, current),
        cohortQuery(organizationId, previous),
      ],
      { isolationLevel: "RepeatableRead" },
    );

  const now = currentState[0];
  const before = previousState[0];
  const mrrNow = toNumber(now?.mrr_cents ?? 0);
  const mrrBefore = toNumber(before?.mrr_cents ?? 0);
  const customersNow = toNumber(now?.customers ?? 0);
  const customersBefore = toNumber(before?.customers ?? 0);
  const subsNow = toNumber(now?.subscriptions ?? 0);
  const subsBefore = toNumber(before?.subscriptions ?? 0);
  const cohortNow = cohortFigures(currentCohort[0]);
  const cohortBefore = cohortFigures(previousCohort[0]);

  return {
    organizationId,
    period: current,
    previousPeriod: previous,
    currency: organization.currency,
    mrrCents: { current: mrrNow, previous: mrrBefore, changePct: percentChange(mrrNow, mrrBefore) },
    arrCents: {
      current: mrrNow * MONTHS_PER_YEAR,
      previous: mrrBefore * MONTHS_PER_YEAR,
      // Identical to the MRR change: ARR is a constant multiple of MRR.
      changePct: percentChange(mrrNow, mrrBefore),
    },
    activeCustomers: {
      current: customersNow,
      previous: customersBefore,
      changePct: percentChange(customersNow, customersBefore),
    },
    activeSubscriptions: {
      current: subsNow,
      previous: subsBefore,
      changePct: percentChange(subsNow, subsBefore),
    },
    customerChurnRate: rateComparison(customerChurnOf(cohortNow), customerChurnOf(cohortBefore)),
    revenueChurnRate: rateComparison(revenueChurnOf(cohortNow), revenueChurnOf(cohortBefore)),
  };
}

/**
 * Net revenue retention over a period.
 *
 * COHORT: the customers active (MRR > 0) at `period.start`. Revenue from customers
 * who became active during the period is excluded — that is what separates NRR
 * from growth. Each cohort member's MRR at `period.end` is compared with their MRR
 * at the start: more is expansion, less-but-not-zero is contraction, zero is
 * churn. A customer who left and came back inside the period is compared on the
 * two instants only, so they count as retained.
 *
 * Empty cohort => `nrr: null`.
 */
export async function getNetRevenueRetention(
  organizationId: string,
  period: Period,
): Promise<NetRevenueRetentionResult> {
  const resolved = resolvePeriod(period);
  const [row] = await cohortQuery(organizationId, resolved);
  const figures = cohortFigures(row);
  const retained =
    figures.startingMRRCents +
    figures.expansionMRRCents -
    figures.contractionMRRCents -
    figures.churnedMRRCents;

  return {
    organizationId,
    period: resolved,
    cohortCustomers: figures.customersAtStart,
    churnedCustomers: figures.churnedCustomers,
    startingMRRCents: figures.startingMRRCents,
    endingMRRCents: figures.endingMRRCents,
    expansionMRRCents: figures.expansionMRRCents,
    contractionMRRCents: figures.contractionMRRCents,
    churnedMRRCents: figures.churnedMRRCents,
    nrr: figures.startingMRRCents === 0 ? null : retained / figures.startingMRRCents,
  };
}

/**
 * Live MRR at `asOf` grouped by plan name, custom-priced subscriptions (no plan)
 * grouped as `CUSTOM_PLAN_LABEL`. Each group is rounded once; the total is
 * rounded once over everything, so it equals the headline MRR even when the
 * group roundings do not add up to it to the cent.
 */
export async function getPlanMix(
  organizationId: string,
  asOf: Date = new Date(),
): Promise<PlanMixResult> {
  interface PlanRow {
    plan_id: string | null;
    plan_name: string | null;
    mrr_cents: NumericLike;
    subscriptions: NumericLike;
    past_due: NumericLike;
  }

  const [rows, state] = await prisma.$transaction(
    [
      prisma.$queryRaw<PlanRow[]>(Prisma.sql`
        SELECT
          s."planId" AS plan_id,
          p.name     AS plan_name,
          ${cents(Prisma.sql`SUM(${monthlyExact("s")})`)} AS mrr_cents,
          COUNT(*)::int AS subscriptions,
          COUNT(*) FILTER (WHERE s.status = 'PAST_DUE'::"SubscriptionStatus")::int AS past_due
        FROM "Subscription" s
        LEFT JOIN "Plan" p
          ON p.id = s."planId"
         AND p."organizationId" = ${organizationId}
        WHERE s."organizationId" = ${organizationId}
          AND ${liveAsOf("s", ts(asOf))}
        GROUP BY s."planId", p.name
        ORDER BY 3 DESC, 2 ASC
      `),
      mrrStateQuery(organizationId, asOf),
    ],
    { isolationLevel: "RepeatableRead" },
  );

  return {
    organizationId,
    asOf,
    totalMRRCents: toNumber(state[0]?.mrr_cents ?? 0),
    totalSubscriptions: toNumber(state[0]?.subscriptions ?? 0),
    byPlan: rows.map((row) => ({
      planId: row.plan_id,
      name: row.plan_name ?? CUSTOM_PLAN_LABEL,
      mrrCents: toNumber(row.mrr_cents),
      subscriptions: toNumber(row.subscriptions),
    })),
    pastDueSubscriptions: rows.reduce((sum, row) => sum + toNumber(row.past_due), 0),
  };
}

/**
 * Month-by-month MRR and customer counts for a chart, read from `MetricSnapshot`.
 *
 * The window ends at the workspace's most recent snapshot (not at "now"), so the
 * chart always terminates on real data. Point-in-time values come from the last
 * snapshot of each month; flows are summed across the month. Months with no
 * snapshot are omitted rather than fabricated as zeros.
 *
 * No snapshots => `[]`. `months <= 0` => `[]`.
 */
export async function getMRRTrend(
  organizationId: string,
  months: number = DEFAULT_TREND_MONTHS,
): Promise<MRRTrendPoint[]> {
  const span = clampMonths(months);
  if (span === 0) return [];
  const monthsBack = span - 1;

  interface TrendRow {
    month: string;
    as_of_date: string;
    mrr_cents: NumericLike;
    active_customers: NumericLike;
    active_subs: NumericLike;
    new_customers: NumericLike;
    churned_customers: NumericLike;
  }

  const rows = await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
    WITH bounds AS (
      SELECT MAX("date") AS latest
      FROM "MetricSnapshot"
      WHERE "organizationId" = ${organizationId}
    )
    SELECT
      to_char(date_trunc('month', m."date"), 'YYYY-MM')                  AS month,
      to_char(MAX(m."date"), 'YYYY-MM-DD')                                AS as_of_date,
      (array_agg(m."mrrCents"        ORDER BY m."date" DESC))[1]::int     AS mrr_cents,
      (array_agg(m."activeCustomers" ORDER BY m."date" DESC))[1]::int     AS active_customers,
      (array_agg(m."activeSubs"      ORDER BY m."date" DESC))[1]::int     AS active_subs,
      SUM(m."newCustomers")::int                                          AS new_customers,
      SUM(m."churnedCustomers")::int                                      AS churned_customers
    FROM "MetricSnapshot" m
    CROSS JOIN bounds b
    WHERE m."organizationId" = ${organizationId}
      AND b.latest IS NOT NULL
      AND m."date" >= (date_trunc('month', b.latest) - (${monthsBack}::int * INTERVAL '1 month'))::date
      AND m."date" <= b.latest
    GROUP BY date_trunc('month', m."date")
    ORDER BY date_trunc('month', m."date") ASC
  `);

  return rows.map((row) => ({
    month: row.month,
    asOfDate: row.as_of_date,
    mrrCents: toNumber(row.mrr_cents),
    activeCustomers: toNumber(row.active_customers),
    activeSubs: toNumber(row.active_subs),
    newCustomers: toNumber(row.new_customers),
    churnedCustomers: toNumber(row.churned_customers),
  }));
}

interface CustomerActivityRow {
  active_customers: NumericLike;
  as_of_date: string | null;
  new_customers: NumericLike;
  churned_customers: NumericLike;
}

/**
 * State and flows for one period from the daily snapshots. A snapshot row for day
 * D holds the state at D's midnight and the flows in (D − 1, D], so the state as
 * of an instant is the latest day `<=` its UTC date and the flows over
 * `(start, end]` are the days strictly after `start`'s date up to `end`'s.
 */
function customerActivityQuery(
  organizationId: string,
  period: ResolvedPeriod,
): Prisma.PrismaPromise<CustomerActivityRow[]> {
  return prisma.$queryRaw<CustomerActivityRow[]>(Prisma.sql`
    WITH latest AS (
      SELECT m."activeCustomers", m."date"
      FROM "MetricSnapshot" m
      WHERE m."organizationId" = ${organizationId}
        AND m."date" <= ${ts(period.end)}::date
      ORDER BY m."date" DESC
      LIMIT 1
    ),
    flows AS (
      SELECT
        COALESCE(SUM(m."newCustomers"), 0)::int     AS new_customers,
        COALESCE(SUM(m."churnedCustomers"), 0)::int AS churned_customers
      FROM "MetricSnapshot" m
      WHERE m."organizationId" = ${organizationId}
        AND m."date" > ${ts(period.start)}::date
        AND m."date" <= ${ts(period.end)}::date
    )
    SELECT
      (SELECT "activeCustomers" FROM latest)::int                  AS active_customers,
      (SELECT to_char("date", 'YYYY-MM-DD') FROM latest)           AS as_of_date,
      flows.new_customers,
      flows.churned_customers
    FROM flows
  `);
}

/**
 * Active, new and churned customers with period-over-period comparison, from the
 * daily snapshots — the same period handling as `getMetricsSummary`.
 */
export async function getCustomerActivity(
  organizationId: string,
  period: Period = { kind: "preset", preset: "last_30_days" },
): Promise<CustomerActivitySummary> {
  const current = resolvePeriod(period);
  const previous = previousOfResolved(period, current);

  const [currentRows, previousRows] = await prisma.$transaction(
    [customerActivityQuery(organizationId, current), customerActivityQuery(organizationId, previous)],
    { isolationLevel: "RepeatableRead" },
  );

  const activeOf = (rows: CustomerActivityRow[]): number | null => {
    const value = rows[0]?.active_customers ?? null;
    return value === null ? null : toNumber(value);
  };
  const flowOf = (rows: CustomerActivityRow[], key: "new_customers" | "churned_customers"): number =>
    toNumber(rows[0]?.[key] ?? 0);

  const activeNow = activeOf(currentRows);
  const activeBefore = activeOf(previousRows);
  const newNow = flowOf(currentRows, "new_customers");
  const newBefore = flowOf(previousRows, "new_customers");
  const churnedNow = flowOf(currentRows, "churned_customers");
  const churnedBefore = flowOf(previousRows, "churned_customers");

  return {
    period: current,
    previousPeriod: previous,
    activeCustomers: {
      current: activeNow,
      previous: activeBefore,
      changePct:
        activeNow === null || activeBefore === null ? null : percentChange(activeNow, activeBefore),
    },
    newCustomers: { current: newNow, previous: newBefore, changePct: percentChange(newNow, newBefore) },
    churnedCustomers: {
      current: churnedNow,
      previous: churnedBefore,
      changePct: percentChange(churnedNow, churnedBefore),
    },
    asOfDate: currentRows[0]?.as_of_date ?? null,
  };
}

interface RevenueMovementRow {
  month: string;
  period_start: Date;
  period_end: Date;
  is_complete: boolean;
  starting_mrr_cents: NumericLike;
  ending_mrr_cents: NumericLike;
  new_mrr_cents: NumericLike;
  reactivation_mrr_cents: NumericLike;
  expansion_mrr_cents: NumericLike;
  contraction_mrr_cents: NumericLike;
  churned_mrr_cents: NumericLike;
  paying_customers_at_start: NumericLike;
  new_customers: NumericLike;
  reactivated_customers: NumericLike;
  churned_customers: NumericLike;
}

/**
 * The revenue bridge: where each month's MRR came from and where it went,
 * attributed per CUSTOMER between consecutive month boundaries (see the
 * definitions in the module header). Rows are labelled by their OPENING month.
 *
 * The in-progress month closes at `asOf`. `months <= 0`, or a workspace with no
 * subscriptions in the window => `[]`.
 */
export async function getRevenueMovement(
  organizationId: string,
  months: number = DEFAULT_TREND_MONTHS,
  asOf: Date = new Date(),
): Promise<RevenueMovementPoint[]> {
  const span = clampMonths(months);
  if (span === 0) return [];
  const window = monthWindow(span, asOf);

  const isNew = Prisma.sql`st.mrr = 0 AND st.next_mrr > 0 AND st.first_paid_at > st.boundary`;
  const isReactivation = Prisma.sql`st.mrr = 0 AND st.next_mrr > 0 AND st.first_paid_at <= st.boundary`;
  const isChurn = Prisma.sql`st.mrr > 0 AND st.next_mrr = 0`;

  const rows = await prisma.$queryRaw<RevenueMovementRow[]>(Prisma.sql`
    WITH ${monthBoundariesCte(window)},
    ${customerSeriesCtes(organizationId, window)},
    per_customer AS (
      SELECT b.boundary, s.customer_id,
             COALESCE(SUM(s.mrr) FILTER (WHERE ${subsLiveAt(Prisma.raw("b.boundary"))}), 0) AS mrr
      FROM boundaries b
      CROSS JOIN subs s
      GROUP BY b.boundary, s.customer_id
    ),
    stepped AS (
      SELECT p.boundary, p.customer_id, p.mrr, f.first_paid_at,
             LEAD(p.mrr)      OVER w AS next_mrr,
             LEAD(p.boundary) OVER w AS next_boundary
      FROM per_customer p
      LEFT JOIN first_paid f ON f.customer_id = p.customer_id
      WINDOW w AS (PARTITION BY p.customer_id ORDER BY p.boundary)
    )
    SELECT
      to_char(st.boundary, 'YYYY-MM')                            AS month,
      st.boundary                                                AS period_start,
      MIN(st.next_boundary)                                      AS period_end,
      (MIN(st.next_boundary) = st.boundary + INTERVAL '1 month') AS is_complete,
      ${cents(Prisma.sql`SUM(st.mrr)`)}                          AS starting_mrr_cents,
      ${cents(Prisma.sql`SUM(st.next_mrr)`)}                     AS ending_mrr_cents,
      ${cents(Prisma.sql`SUM(st.next_mrr) FILTER (WHERE ${isNew})`)}          AS new_mrr_cents,
      ${cents(Prisma.sql`SUM(st.next_mrr) FILTER (WHERE ${isReactivation})`)} AS reactivation_mrr_cents,
      ${cents(Prisma.sql`SUM(st.next_mrr - st.mrr) FILTER (WHERE st.mrr > 0 AND st.next_mrr > st.mrr)`)}
        AS expansion_mrr_cents,
      ${cents(Prisma.sql`SUM(st.mrr - st.next_mrr) FILTER (WHERE st.mrr > 0 AND st.next_mrr > 0 AND st.next_mrr < st.mrr)`)}
        AS contraction_mrr_cents,
      ${cents(Prisma.sql`SUM(st.mrr) FILTER (WHERE ${isChurn})`)} AS churned_mrr_cents,
      COUNT(*) FILTER (WHERE st.mrr > 0)::int                    AS paying_customers_at_start,
      COUNT(*) FILTER (WHERE ${isNew})::int                      AS new_customers,
      COUNT(*) FILTER (WHERE ${isReactivation})::int             AS reactivated_customers,
      COUNT(*) FILTER (WHERE ${isChurn})::int                    AS churned_customers
    FROM stepped st
    WHERE st.next_boundary IS NOT NULL
    GROUP BY st.boundary
    ORDER BY st.boundary ASC
  `);

  return rows.map((row) => {
    const startingMRRCents = toNumber(row.starting_mrr_cents);
    const expansionMRRCents = toNumber(row.expansion_mrr_cents);
    const contractionMRRCents = toNumber(row.contraction_mrr_cents);
    const churnedMRRCents = toNumber(row.churned_mrr_cents);
    const retained = startingMRRCents + expansionMRRCents - contractionMRRCents - churnedMRRCents;
    const gross = startingMRRCents - contractionMRRCents - churnedMRRCents;

    return {
      month: row.month,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      isComplete: row.is_complete,
      startingMRRCents,
      endingMRRCents: toNumber(row.ending_mrr_cents),
      newMRRCents: toNumber(row.new_mrr_cents),
      reactivationMRRCents: toNumber(row.reactivation_mrr_cents),
      expansionMRRCents,
      contractionMRRCents,
      churnedMRRCents,
      payingCustomersAtStart: toNumber(row.paying_customers_at_start),
      newCustomers: toNumber(row.new_customers),
      reactivatedCustomers: toNumber(row.reactivated_customers),
      churnedCustomers: toNumber(row.churned_customers),
      nrr: startingMRRCents === 0 ? null : retained / startingMRRCents,
      grr: startingMRRCents === 0 ? null : gross / startingMRRCents,
    };
  });
}

interface ChurnTrendRow {
  month: string;
  start_at: Date;
  end_at: Date;
  is_complete: boolean;
  customers_at_start: NumericLike;
  churned_customers: NumericLike;
  starting_mrr_cents: NumericLike;
  churned_mrr_cents: NumericLike;
}

/**
 * Customer churn and revenue churn, month by month — the same cohort definition
 * as `getMetricsSummary`, applied to each (month start, next month start] window,
 * so a month's point equals `getMetricsSummary` over that range.
 *
 * Every month in the window yields a row, with `rate: null` where no customer was
 * active at its open: an explicit gap, not an empty series.
 *
 * `months <= 0` => `[]`.
 */
export async function getChurnRateTrend(
  organizationId: string,
  months: number = DEFAULT_TREND_MONTHS,
  asOf: Date = new Date(),
): Promise<ChurnRateTrendPoint[]> {
  const span = clampMonths(months);
  if (span === 0) return [];
  const window = monthWindow(span, asOf);

  const rows = await prisma.$queryRaw<ChurnTrendRow[]>(Prisma.sql`
    WITH ${monthBoundariesCte(window)},
    ${customerSeriesCtes(organizationId, window)},
    windows AS (
      SELECT boundary AS start_at, LEAD(boundary) OVER (ORDER BY boundary) AS end_at
      FROM boundaries
    ),
    per_customer AS (
      SELECT w.start_at, s.customer_id,
             COALESCE(SUM(s.mrr) FILTER (WHERE ${subsLiveAt(Prisma.raw("w.start_at"))}), 0) AS start_mrr,
             COALESCE(SUM(s.mrr) FILTER (WHERE ${subsLiveAt(Prisma.raw("w.end_at"))}), 0)   AS end_mrr
      FROM windows w
      CROSS JOIN subs s
      WHERE w.end_at IS NOT NULL
      GROUP BY w.start_at, s.customer_id
    )
    SELECT
      to_char(w.start_at, 'YYYY-MM')                    AS month,
      w.start_at                                        AS start_at,
      w.end_at                                          AS end_at,
      (w.end_at = w.start_at + INTERVAL '1 month')      AS is_complete,
      COUNT(p.customer_id) FILTER (WHERE p.start_mrr > 0)::int                      AS customers_at_start,
      COUNT(p.customer_id) FILTER (WHERE p.start_mrr > 0 AND p.end_mrr = 0)::int    AS churned_customers,
      ${cents(Prisma.sql`SUM(p.start_mrr) FILTER (WHERE p.start_mrr > 0)`)}        AS starting_mrr_cents,
      ${cents(Prisma.sql`SUM(p.start_mrr) FILTER (WHERE p.start_mrr > 0 AND p.end_mrr = 0)`)}
        AS churned_mrr_cents
    FROM windows w
    LEFT JOIN per_customer p ON p.start_at = w.start_at
    WHERE w.end_at IS NOT NULL
    GROUP BY w.start_at, w.end_at
    ORDER BY w.start_at ASC
  `);

  return rows.map((row) => {
    const customersAtStart = toNumber(row.customers_at_start);
    const churnedCustomers = toNumber(row.churned_customers);
    const startingMRRCents = toNumber(row.starting_mrr_cents);
    const churnedMRRCents = toNumber(row.churned_mrr_cents);
    return {
      month: row.month,
      period: { start: row.start_at, end: row.end_at },
      isComplete: row.is_complete,
      customersAtStart,
      churnedCustomers,
      rate: customersAtStart === 0 ? null : churnedCustomers / customersAtStart,
      startingMRRCents,
      churnedMRRCents,
      revenueRate: startingMRRCents === 0 ? null : churnedMRRCents / startingMRRCents,
    };
  });
}

/**
 * Invoice history, newest first, with each invoice's customer and plan in the
 * same round trip.
 *
 * The tenant filter is applied on `Invoice` and again on the joined `Customer`:
 * an invoice whose customer belongs to another workspace is corrupt data, and it
 * must not leak through the relation.
 *
 * Paging is KEYSET on `[issuedAt desc, id desc]` — a total order, so a cursor is
 * stable under concurrent inserts and costs the same on page 50 as on page 1.
 *
 * No invoices => `{ invoices: [], nextCursor: null }`.
 */
export async function getInvoices(
  organizationId: string,
  options: InvoiceListOptions = {},
): Promise<InvoiceListResult> {
  const take = Math.max(1, Math.min(Math.trunc(options.limit ?? 10) || 1, 100));

  // An AND list so each filter composes without clobbering the others — the
  // keyset OR in particular must never become a top-level OR beside the tenant filter.
  const filters: Prisma.InvoiceWhereInput[] = [];

  if (options.period) {
    const resolved = resolvePeriod(options.period);
    filters.push({ issuedAt: { gt: resolved.start, lte: resolved.end } });
  }
  if (options.statuses && options.statuses.length > 0) {
    filters.push({ status: { in: [...options.statuses] } });
  }
  if (options.cursor) {
    filters.push({
      OR: [
        { issuedAt: { lt: options.cursor.issuedAt } },
        { issuedAt: options.cursor.issuedAt, id: { lt: options.cursor.id } },
      ],
    });
  }

  const rows = await prisma.invoice.findMany({
    where: {
      organizationId,
      customer: { is: { organizationId } },
      ...(filters.length > 0 ? { AND: filters } : {}),
    },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      amountCents: true,
      status: true,
      issuedAt: true,
      dueAt: true,
      paidAt: true,
      customer: { select: { id: true, name: true } },
      subscription: { select: { plan: { select: { name: true } } } },
    },
  });

  const page = rows.slice(0, take);
  const last = page[page.length - 1];

  return {
    invoices: page.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      status: row.status,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      paidAt: row.paidAt,
      customer: row.customer,
      planName:
        row.subscription === null ? null : (row.subscription.plan?.name ?? CUSTOM_PLAN_LABEL),
    })),
    nextCursor:
      rows.length > take && last !== undefined ? { issuedAt: last.issuedAt, id: last.id } : null,
  };
}

/** The newest `limit` invoices. No invoices => `[]`. */
export async function getRecentInvoices(
  organizationId: string,
  limit: number = 10,
): Promise<RecentInvoice[]> {
  const { invoices } = await getInvoices(organizationId, { limit });
  return invoices;
}

interface InvoiceTotalsRow {
  status: InvoiceStatus;
  issued_count: NumericLike;
  issued_cents: NumericLike;
  collected_cents: NumericLike;
  outstanding_cents: NumericLike;
}

/**
 * Collected vs outstanding invoice money for a period. The two headline figures
 * are measured on DIFFERENT populations on purpose:
 *   - collected is a FLOW — paid in `(start, end]`, whenever it was issued;
 *   - outstanding is a STOCK — every OPEN invoice issued at or before `end`;
 *   - issued and byStatus cover invoices ISSUED in `(start, end]`.
 *
 * Tenant filter on Invoice and again on the joined Customer, as in getInvoices.
 */
export async function getInvoiceTotals(
  organizationId: string,
  period: Period,
): Promise<InvoiceTotals> {
  const resolved = resolvePeriod(period);
  const startTs = ts(resolved.start);
  const endTs = ts(resolved.end);
  const issuedInPeriod = Prisma.sql`i."issuedAt" > ${startTs} AND i."issuedAt" <= ${endTs}`;

  const [organization, rows] = await prisma.$transaction([
    currencyQuery(organizationId),
    prisma.$queryRaw<InvoiceTotalsRow[]>(Prisma.sql`
      SELECT
        i.status AS status,
        COUNT(*) FILTER (WHERE ${issuedInPeriod})::int AS issued_count,
        COALESCE(SUM(i."amountCents") FILTER (WHERE ${issuedInPeriod}), 0)::bigint AS issued_cents,
        COALESCE(SUM(i."amountCents") FILTER (
          WHERE i.status = 'PAID'::"InvoiceStatus"
            AND i."paidAt" IS NOT NULL
            AND i."paidAt" > ${startTs}
            AND i."paidAt" <= ${endTs}
        ), 0)::bigint AS collected_cents,
        COALESCE(SUM(i."amountCents") FILTER (
          WHERE i.status = 'OPEN'::"InvoiceStatus"
            AND i."issuedAt" <= ${endTs}
        ), 0)::bigint AS outstanding_cents
      FROM "Invoice" i
      JOIN "Customer" c
        ON c.id = i."customerId"
       AND c."organizationId" = ${organizationId}
      WHERE i."organizationId" = ${organizationId}
      GROUP BY i.status
    `),
  ]);

  let collectedCents = 0;
  let outstandingCents = 0;
  let issuedCents = 0;
  const byStatus: InvoiceStatusTotal[] = [];

  for (const row of rows) {
    collectedCents += toNumber(row.collected_cents);
    outstandingCents += toNumber(row.outstanding_cents);
    const issued = toNumber(row.issued_cents);
    issuedCents += issued;
    const count = toNumber(row.issued_count);
    if (count > 0) byStatus.push({ status: row.status, count, amountCents: issued });
  }

  return {
    organizationId,
    period: resolved,
    currency: organization.currency,
    collectedCents,
    outstandingCents,
    issuedCents,
    byStatus: byStatus.sort((a, b) => b.amountCents - a.amountCents),
  };
}

interface CustomerListSqlRow {
  id: string;
  name: string;
  email: string | null;
  mrr_cents: NumericLike;
  is_active: boolean;
  past_due: boolean;
  first_paid_at: Date | null;
  last_paid_end: Date | null;
  live_plans: string[] | null;
}

/**
 * The workspace's customers as of `asOf`, each with their current MRR, state and
 * dates. One grouped query over Customer ⟕ Subscription ⟕ Plan, every join
 * tenant-filtered. Each customer's MRR is rounded once over their own live
 * subscriptions.
 */
export async function getCustomerList(
  organizationId: string,
  asOf: Date = new Date(),
): Promise<CustomerListResult> {
  const live = liveAsOf("s", ts(asOf));
  const paying = Prisma.sql`${monthlyExact("s")} > 0`;

  const [organization, rows] = await prisma.$transaction(
    [
      currencyQuery(organizationId),
      prisma.$queryRaw<CustomerListSqlRow[]>(Prisma.sql`
        SELECT
          c.id,
          c.name,
          c.email,
          ${cents(Prisma.sql`SUM(${monthlyExact("s")}) FILTER (WHERE ${live})`)} AS mrr_cents,
          COALESCE(BOOL_OR(${paying} AND ${live}), false)                          AS is_active,
          COALESCE(BOOL_OR(s.status = 'PAST_DUE'::"SubscriptionStatus" AND ${live}), false)
            AS past_due,
          MIN(s."startedAt") FILTER (
            WHERE ${paying} AND (s."endedAt" IS NULL OR s."endedAt" > s."startedAt")
          )                                                                         AS first_paid_at,
          MAX(s."endedAt") FILTER (WHERE ${paying})                                 AS last_paid_end,
          array_agg(DISTINCT COALESCE(p.name, ${CUSTOM_PLAN_LABEL})) FILTER (WHERE ${live})
                                                                                    AS live_plans
        FROM "Customer" c
        LEFT JOIN "Subscription" s
          ON s."customerId" = c.id
         AND s."organizationId" = ${organizationId}
        LEFT JOIN "Plan" p
          ON p.id = s."planId"
         AND p."organizationId" = ${organizationId}
        WHERE c."organizationId" = ${organizationId}
          AND c."archivedAt" IS NULL
        GROUP BY c.id, c.name, c.email
        ORDER BY 4 DESC, c.name ASC
      `),
    ],
    { isolationLevel: "RepeatableRead" },
  );

  const asOfMs = asOf.getTime();
  const customers: CustomerListRow[] = rows.map((row) => {
    const everPaid = row.first_paid_at !== null && row.first_paid_at.getTime() <= asOfMs;
    const state: CustomerState = row.is_active ? "active" : everPaid ? "churned" : "inactive";
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      state,
      pastDue: row.past_due,
      mrrCents: toNumber(row.mrr_cents),
      livePlans:
        row.live_plans === null || row.live_plans.length === 0
          ? null
          : [...row.live_plans].sort((a, b) => a.localeCompare(b)).join(", "),
      customerSince: everPaid ? row.first_paid_at : null,
      churnedAt: state === "churned" ? row.last_paid_end : null,
    };
  });

  const active = customers.filter((customer) => customer.state === "active");
  const activeMRR = active.reduce((sum, customer) => sum + customer.mrrCents, 0);

  return {
    organizationId,
    asOf,
    currency: organization.currency,
    customers,
    activeCount: active.length,
    churnedCount: customers.filter((customer) => customer.state === "churned").length,
    averageMRRCents: active.length === 0 ? 0 : Math.round(activeMRR / active.length),
  };
}

/**
 * Customers who came BACK over a period, from the daily snapshots — the same
 * source and window as `getCustomerActivity`'s new and churned counts.
 *
 * A snapshot stores active, new and churned customers, and day to day
 * `active − previous active = new + reactivated − churned` (new means never
 * active before; everyone else who turns active is a return). So each day's
 * reactivations are that difference rearranged, summed over (start, end].
 */
export async function getReactivatedCustomers(organizationId: string, period: Period): Promise<number> {
  const resolved = resolvePeriod(period);
  const rows = await prisma.$queryRaw<{ reactivated: NumericLike }[]>(Prisma.sql`
    WITH days AS (
      SELECT m."date", m."activeCustomers", m."newCustomers", m."churnedCustomers",
             LAG(m."activeCustomers") OVER (ORDER BY m."date") AS previous_active
      FROM "MetricSnapshot" m
      WHERE m."organizationId" = ${organizationId}
        AND m."date" >= ${ts(resolved.start)}::date
        AND m."date" <= ${ts(resolved.end)}::date
    )
    SELECT COALESCE(SUM(GREATEST(
      "activeCustomers" - COALESCE(previous_active, 0) - "newCustomers" + "churnedCustomers", 0
    )), 0)::int AS reactivated
    FROM days
    WHERE "date" > ${ts(resolved.start)}::date
  `);
  return toNumber(rows[0]?.reactivated ?? 0);
}
