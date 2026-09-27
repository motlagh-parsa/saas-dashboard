import "server-only";

import { Prisma } from "@prisma/client";
import type { BillingInterval, InvoiceStatus, PlanTier, SubscriptionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * SaaS metrics query layer.
 *
 * Contract for every function in this file:
 *   - Tenant-scoped. `organizationId` is required and is applied to EVERY table
 *     touched by the query, including the recursive branch of the NRR CTE and the
 *     related Subscription reached through Invoice. A missing tenant filter is a
 *     security bug, not a perf bug.
 *   - Money is INTEGER MINOR UNITS (cents). No floats, no formatting, no symbols.
 *   - Aggregation happens in Postgres (`groupBy` / `count` / `$queryRaw`). Nothing
 *     here pulls a table into JS to reduce it.
 *   - Raw SQL is always `Prisma.sql` tagged templates; every value is a bind
 *     parameter. Nothing is string-interpolated into SQL.
 *
 * ---------------------------------------------------------------------------
 * "Active" is decided by DATES, not by `status`
 * ---------------------------------------------------------------------------
 * `Subscription.status` is the TERMINAL state of a lifecycle segment: the seed
 * (prisma/seed.ts) stamps `CANCELED` on every segment that has ended, including
 * plan-change hand-offs where the customer never actually left. So `status` cannot
 * distinguish "churned" from "upgraded", and it is wrong for any as-of-a-past-date
 * question. Activity is therefore always:
 *
 *     startedAt <= asOf AND (endedAt IS NULL OR endedAt > asOf)
 *
 * i.e. a segment is inactive ON its `endedAt` instant. This is the same predicate
 * the seed uses to build `MetricSnapshot.activeSubs` / `mrrCents`, so `getMRR()`
 * reconciles exactly with the latest point of `getMRRTrend()`.
 *
 * Practical consequence for statuses: `ACTIVE`, `PAST_DUE` and `TRIALING` segments
 * all count toward MRR while they are live (PAST_DUE is still a subscription that
 * has not been cancelled; TRIALING rows in this dataset are FREE tier and therefore
 * contribute 0). `CANCELED` rows are excluded by their `endedAt`, not by status.
 *
 * ---------------------------------------------------------------------------
 * Period boundary convention
 * ---------------------------------------------------------------------------
 * A `ResolvedPeriod` is `{ start, end }`, both instants.
 *   - STATE (MRR, active counts) is measured AS OF `start` and AS OF `end`.
 *   - EVENTS (cancellations) are attributed to the period when they fall in
 *     `(start, end]` — left-open, right-closed.
 * That pairing is what makes the numbers consistent: a segment whose `endedAt` is
 * exactly `end` is still active at `end`-as-of... no — it is NOT active at `end`
 * (inactive on its endedAt), and its cancellation lands in `(start, end]`. So it is
 * counted as churn exactly once, in exactly this period, and never double-counted
 * by the next one (it is not in the next period's opening cohort).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `Subscription.currency` / `Invoice.currency` schema defaults. */
const DEFAULT_CURRENCY = "USD";

const MONTHS_PER_YEAR = 12;

/** Default and hard cap for `getMRRTrend`'s window, in calendar months. */
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 60;

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

/** A period reduced to two concrete UTC instants. See the boundary convention above. */
export interface ResolvedPeriod {
  readonly start: Date;
  readonly end: Date;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface MRRResult {
  readonly organizationId: string;
  /** Instant the figure was measured at. */
  readonly asOf: Date;
  /** Monthly recurring revenue in integer minor units (cents). */
  readonly mrrCents: number;
  /** ISO-4217 code of the largest contributing currency bucket. */
  readonly currency: string;
  /**
   * True when the org has live subscriptions in more than one currency. The schema
   * stores no FX rates, so amounts are summed as-is; the caller must decide what to
   * do about it rather than silently trusting a mixed-currency total.
   */
  readonly isMixedCurrency: boolean;
  /** Live subscription segments that produced this figure (includes FREE tier). */
  readonly activeSubscriptions: number;
}

export interface ARRResult {
  readonly organizationId: string;
  readonly asOf: Date;
  /** Annual recurring revenue in cents. Definitionally `mrrCents * 12`. */
  readonly arrCents: number;
  readonly mrrCents: number;
  readonly currency: string;
  readonly isMixedCurrency: boolean;
}

export interface ChurnRateResult {
  readonly organizationId: string;
  readonly period: ResolvedPeriod;
  /**
   * Subscription SEGMENTS live as of `period.start` — the churn DENOMINATOR. Not a
   * customer count; see the CHAIN VS SEGMENT note on `RevenueMovementPoint`.
   */
  readonly activeAtPeriodStart: number;
  /** Members of that opening cohort cancelled within `(start, end]` — the NUMERATOR. */
  readonly churnedInPeriod: number;
  /**
   * Churned / active-at-start, as a FRACTION (0.05 = 5%), always in [0, 1].
   * `null` when the denominator is 0 (no subscriptions at period start), because
   * the rate is genuinely undefined there — never NaN/Infinity.
   */
  readonly rate: number | null;
}

export interface NetRevenueRetentionResult {
  readonly organizationId: string;
  readonly period: ResolvedPeriod;
  /**
   * Number of PAYING subscription SEGMENTS in the opening cohort.
   *
   * Two things this is not. It excludes FREE-tier / zero-MRR segments, which are not
   * part of a revenue-retention cohort at all (see collision C1 in the query below).
   * And it counts segments, not customers -- see the CHAIN VS SEGMENT note on
   * `RevenueMovementPoint`. Do not render it beside a customer count.
   */
  readonly cohortSize: number;
  /** Cohort MRR as of `period.start`, in cents. */
  readonly startingMRRCents: number;
  /** Same cohort's MRR as of `period.end`, in cents. */
  readonly endingMRRCents: number;
  /** Upgrades within the cohort, in cents (>= 0). */
  readonly expansionMRRCents: number;
  /** Downgrades within the cohort, in cents (>= 0, reported as a positive number). */
  readonly contractionMRRCents: number;
  /** Cohort MRR fully lost to cancellation, in cents (>= 0). */
  readonly churnedMRRCents: number;
  /**
   * (starting + expansion - contraction - churn) / starting, as a FRACTION
   * (1.12 = 112% NRR). `null` when the cohort is empty — undefined, not 0.
   *
   * Since the cohort now admits only paying segments, `startingMRRCents` is 0 exactly
   * when `cohortSize` is 0, so a null NRR always means "no paying customers at period
   * start" rather than the old ambiguous "cohort existed but billed nothing".
   */
  readonly nrr: number | null;
}

export interface PlanTierCount {
  readonly tier: PlanTier;
  readonly count: number;
}

export interface SubscriptionStatusCount {
  readonly status: SubscriptionStatus;
  readonly count: number;
}

export interface ActiveSubscriptionsResult {
  readonly organizationId: string;
  readonly asOf: Date;
  /**
   * Live subscription SEGMENTS, not customers — see the CHAIN VS SEGMENT note on
   * `RevenueMovementPoint`. Do not render this beside a lifecycle/customer count.
   */
  readonly total: number;
  /** Only tiers actually present, highest count first. Absent tier => 0. */
  readonly byTier: readonly PlanTierCount[];
  /**
   * Terminal-status mix of the live segments — useful for surfacing PAST_DUE.
   * NOT used to determine activity (see the module header).
   */
  readonly byStatus: readonly SubscriptionStatusCount[];
}

export interface MRRTrendPoint {
  /** UTC calendar month, `YYYY-MM`. Rendering/timezone is a presentation concern. */
  readonly month: string;
  /** UTC date of the snapshot the point-in-time values were read from, `YYYY-MM-DD`. */
  readonly asOfDate: string;
  /**
   * Month-end MRR in cents, read from the LAST SNAPSHOT of the month.
   *
   * That instant is convention (A) of collision C3 — see the "Month-bucketed series"
   * banner further down. `getRevenueMovement` and `getChurnRateTrend` use convention
   * (B), the month boundary. The two agree except in a month containing an event dated
   * exactly the 1st of the following month, where they differ by that segment's MRR.
   */
  readonly mrrCents: number;
  /**
   * Month-end count of live SEGMENTS, not customers — see the CHAIN VS SEGMENT note on
   * `RevenueMovementPoint`.
   */
  readonly activeSubs: number;
  /** Flow metrics: summed across every snapshot in the month. */
  readonly newSubs: number;
  readonly churnedSubs: number;
}

/**
 * One calendar month of the revenue bridge.
 *
 * ---------------------------------------------------------------------------
 * CHAIN VS SEGMENT — do not put these counts next to each other
 * ---------------------------------------------------------------------------
 * There is no `Customer` table. `Organization` is the TENANT, and a customer is only
 * reconstructible as a maximal chain of `Subscription` segments linked by
 * `previousSubscriptionId`. So there are two different denominators in this file and
 * they are not interchangeable:
 *
 *   - SEGMENT counts — `getActiveSubscriptions().total`, `getMRRTrend().activeSubs`,
 *     `getChurnRateTrend().activeAtStart`, `NetRevenueRetentionResult.cohortSize`.
 *   - CHAIN counts — the buckets below, which attribute money to a whole lifecycle so
 *     that an upgrade is one customer expanding rather than one death and one birth.
 *
 * A single customer mid-plan-change is one chain and one live segment, so the two
 * agree in the common case and diverge exactly when it matters. Label any axis built
 * from these "subscriptions" or "lifecycles" — never silently "customers".
 */
export interface RevenueMovementPoint {
  /** UTC calendar month `YYYY-MM`. This is the month the movement happened IN. */
  readonly month: string;
  /** Opening boundary — MRR is measured as of this instant. */
  readonly periodStart: Date;
  /** Closing boundary. `periodStart` + 1 month, except for a partial trailing month. */
  readonly periodEnd: Date;
  /** False for the in-progress month, whose closing boundary is `asOf`, not a month start. */
  readonly isComplete: boolean;
  readonly startingMRRCents: number;
  readonly endingMRRCents: number;
  /** First time this lifecycle ever billed anything. */
  readonly newMRRCents: number;
  /** A lifecycle that had billed before, fell to 0 MRR, and came back. */
  readonly reactivationMRRCents: number;
  readonly expansionMRRCents: number;
  /** Downgrades, as a positive magnitude. */
  readonly contractionMRRCents: number;
  /** Lifecycles that fell to 0 MRR, as a positive magnitude. */
  readonly churnedMRRCents: number;
  /** Chains billing more than 0 at `periodStart` — the NRR/GRR denominator. */
  readonly payingChainsAtStart: number;
  /**
   * Net revenue retention for this month's opening cohort, as a FRACTION.
   * `(starting + expansion - contraction - churned) / starting`. `null` when nothing
   * was billing at `periodStart`. Excludes `new` and `reactivation` by construction —
   * that is what separates retention from growth.
   */
  readonly nrr: number | null;
  /**
   * Gross revenue retention: `(starting - contraction - churned) / starting`. Never
   * exceeds 1. `null` on the same condition as `nrr`.
   */
  readonly grr: number | null;
}

/** One calendar month of subscription churn, computed the way `getChurnRate` computes it. */
export interface ChurnRateTrendPoint {
  /** UTC calendar month `YYYY-MM`. */
  readonly month: string;
  /** The window churn events were attributed to, left-open/right-closed. */
  readonly period: ResolvedPeriod;
  readonly isComplete: boolean;
  /** Subscription SEGMENTS live at `period.start` — see the CHAIN VS SEGMENT note. */
  readonly activeAtStart: number;
  /** Members of that opening cohort cancelled within `(start, end]`. */
  readonly churned: number;
  /** `churned / activeAtStart` as a FRACTION in [0, 1]; `null` when the denominator is 0. */
  readonly rate: number | null;
}

/** Keyset pagination cursor. Matches the `[issuedAt desc, id desc]` ordering. */
export interface InvoiceCursor {
  readonly issuedAt: Date;
  readonly id: string;
}

export interface InvoiceListOptions {
  /** Filters on `issuedAt`, using the file's `(start, end]` event convention. */
  readonly period?: Period;
  /** Empty or omitted means every status. */
  readonly statuses?: readonly InvoiceStatus[];
  /** Clamped to [1, 100]. */
  readonly limit?: number;
  readonly cursor?: InvoiceCursor;
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
  readonly isMixedCurrency: boolean;
  /**
   * Cash that ARRIVED in `(start, end]`, bucketed by `paidAt`. A flow.
   * An invoice issued in March and paid in April is April's collection.
   */
  readonly collectedCents: number;
  /**
   * Balance still OPEN as of `period.end`, bucketed by `issuedAt <= end`. A stock, not
   * a flow: it deliberately includes invoices issued before the period and still
   * unpaid, because that is what "outstanding" means on a dashboard.
   */
  readonly outstandingCents: number;
  /** Face value of everything issued in `(start, end]`, whatever its status. */
  readonly issuedCents: number;
  /** Statuses actually present among invoices issued in the period, largest first. */
  readonly byStatus: readonly InvoiceStatusTotal[];
}

export interface RecentInvoice {
  readonly id: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly paidAt: Date | null;
  readonly subscription: {
    readonly id: string;
    readonly tier: PlanTier;
    readonly interval: BillingInterval;
  };
}

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

export interface ChurnComparison extends MetricComparison<number | null> {
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
  readonly currency: string;
  readonly isMixedCurrency: boolean;
  /** MRR measured as of each period's `end`. */
  readonly mrrCents: MetricComparison<number>;
  /** ARR measured as of each period's `end`. Always `mrrCents * 12`. */
  readonly arrCents: MetricComparison<number>;
  /** Live subscription count as of each period's `end`. */
  readonly activeSubscriptions: MetricComparison<number>;
  /** Churn rate computed over each period. */
  readonly churnRate: ChurnComparison;
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
 * Every `months` parameter in this file is the kind of value that arrives from
 * `Number(searchParams.get("months"))`, so `NaN` is reachable from a URL. It has to be
 * caught BEFORE the clamp: `Math.max(NaN, 0)` and `Math.min(NaN, 60)` are both `NaN`,
 * which would bind straight into `$n::int` and make Postgres reject the statement with
 * `invalid input syntax for type integer: "NaN"` — a 500, not an empty chart.
 * `+/-Infinity` clamp normally. 0 and negatives mean zero months, which callers return
 * as an empty series rather than silently widening to one month.
 */
function clampMonths(months: number): number {
  const requested = Number.isNaN(months) ? DEFAULT_TREND_MONTHS : Math.trunc(months);
  return Math.min(Math.max(requested, 0), MAX_TREND_MONTHS);
}

/** The boundary instants a month-bucketed series is measured at. See the C3 note. */
interface MonthWindow {
  /** Opening boundary of the earliest month returned. */
  readonly firstBoundary: Date;
  /** Start of the calendar month containing `asOf`. */
  readonly lastMonthStart: Date;
  readonly asOf: Date;
}

/**
 * `span` months of boundaries ending at `asOf`.
 *
 * Produces `span` month starts plus, when `asOf` is mid-month, a final boundary at
 * `asOf` itself — so the caller gets `span` movement rows, the last of which is the
 * in-progress month. When `asOf` is exactly a month start the in-progress month is
 * empty and there are `span - 1` rows.
 */
function monthWindow(span: number, asOf: Date): MonthWindow {
  const lastMonthStart = startOfMonthUTC(asOf);
  return { firstBoundary: addMonthsUTC(lastMonthStart, -(span - 1)), lastMonthStart, asOf };
}

/**
 * The month boundaries of a `MonthWindow`, as a one-column `boundary` relation.
 * The `UNION` tail adds the in-progress month's closing instant and is a no-op when
 * `asOf` is already a month start.
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
 * The comparison window preceding an ALREADY-RESOLVED period.
 *
 * Split out from `previousPeriod` so a caller that needs both windows resolves the
 * period exactly once. `resolvePeriod` calls `new Date()` when a preset carries no
 * `asOf`, so calling it twice yields two different `now`s: `previousPeriod().end`
 * would land a millisecond or so after `resolvePeriod().start`, the two windows would
 * overlap, and a cancellation in that sliver would be counted in both.
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
 * The comparison window immediately preceding `period`.
 * Calendar presets shift by whole months (so "last month" compares against the
 * month before it, not "30 days earlier"); day-based presets and explicit ranges
 * shift by their own duration.
 *
 * NOTE: for a preset with no `asOf` this resolves `period` independently, so pairing
 * it with a separate `resolvePeriod(period)` call reintroduces the skew described on
 * `previousOfResolved`. Resolve once and use `previousOfResolved` when you need both.
 *
 * Day-based presets and ranges are exactly contiguous with their previous window
 * (`previous.end === current.start`). `month_to_date` deliberately is NOT: it compares
 * MTD against the same slice of the prior month, leaving the tail of that month in
 * neither window.
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
 * wall-clock. Prisma maps `DateTime` to `TIMESTAMP(3)` WITHOUT TIME ZONE holding
 * the UTC instant, so sending a timestamptz here would let the server's session
 * time zone shift every comparison. Still a bind parameter — `$n::timestamp`.
 */
function ts(value: Date): Prisma.Sql {
  return Prisma.sql`${value.toISOString()}::timestamp`;
}

/**
 * Table aliases a `Subscription` row can carry in this file's SQL.
 *
 * A closed union, checked at COMPILE time. `Prisma.raw` is the only way to put an
 * identifier into a query -- an alias cannot be a bind parameter -- so restricting the
 * input to these four literals is what keeps the module header's "nothing is
 * string-interpolated into SQL" promise honest. A typo is a type error, never a runtime
 * SQL error, and no caller-supplied value can ever reach `Prisma.raw`.
 */
type SubscriptionAlias = "s" | "c" | "ch" | "r";

/**
 * Interval normalization for a `Subscription` under `alias`.
 * MONTHLY contributes its full amount; YEARLY is spread evenly over 12 months and
 * rounded PER ROW (matching prisma/seed.ts, so MRR reconciles with MetricSnapshot).
 * FREE never contributes, whatever amount happens to be stored on the row.
 * `BillingInterval` currently has exactly these two members; a new member would
 * fall through to the monthly branch and must be added here explicitly.
 *
 * This was three hand-copied CASE blocks. Every derived figure in the file runs through
 * it, so drift between copies would have silently changed MRR, NRR and the revenue
 * bridge independently of one another.
 */
function normalizedMonthlyCents(alias: SubscriptionAlias): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`
  (CASE
     WHEN ${a}.tier = 'FREE'::"PlanTier" THEN 0
     WHEN ${a}."interval" = 'YEARLY'::"BillingInterval" THEN ROUND(${a}."amountCents"::numeric / 12)
     ELSE ${a}."amountCents"::numeric
   END)`;
}

/**
 * Live-as-of predicate: `startedAt <= instant AND (endedAt IS NULL OR endedAt > instant)`.
 * A segment is inactive ON its `endedAt`. `instant` is a `Prisma.Sql` rather than a `Date`
 * so callers can pass either a bind parameter (`ts(d)`) or a column reference from an
 * enclosing query (a month boundary), which is what the trend queries need.
 */
function liveAsOf(alias: SubscriptionAlias, instant: Prisma.Sql): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}."startedAt" <= ${instant} AND (${a}."endedAt" IS NULL OR ${a}."endedAt" > ${instant})`;
}

/** Live-as-of predicate for a `Subscription` aliased `s`. Dates, never status. */
function activeAsOf(asOf: Date): Prisma.Sql {
  return liveAsOf("s", ts(asOf));
}

/**
 * Two comma-joined CTE definitions to follow `WITH RECURSIVE`, exposing `chain_roots`:
 * every one of the org's subscription segments labelled with the id of the segment that
 * STARTED its lifecycle (`root_id`).
 *
 * A "customer" has no table of its own (see the CHAIN VS SEGMENT note below). The nearest
 * thing is a maximal chain of segments linked by `previousSubscriptionId`, and its head --
 * the segment with no predecessor -- is the closest available customer identity. Because
 * that column is `@unique`, the hand-off graph is a forest of simple paths, so this walk
 * assigns every segment to EXACTLY ONE root and cannot double-count.
 *
 * The recursion is deliberately unfiltered by date: a chain whose root ended years ago can
 * still be live today, so pruning the base case would drop live revenue. `overlapping`
 * instead prunes the PROJECTION, after labelling is complete. That matters because callers
 * cross-join this against month boundaries, which is O(segments x months) -- the one part
 * of the trend queries that grows badly. Segments entirely outside the window contribute 0
 * to every bucket, so dropping them changes no result.
 *
 * Tenant filter is applied in BOTH the base and the recursive branch.
 */
function chainRootsCte(organizationId: string, overlapping?: ResolvedPeriod): Prisma.Sql {
  const projection = overlapping
    ? Prisma.sql`WHERE ("endedAt" IS NULL OR "endedAt" > ${ts(overlapping.start)})
                   AND "startedAt" <= ${ts(overlapping.end)}`
    : Prisma.empty;

  return Prisma.sql`
    chain_walk AS (
      SELECT
        s.id AS root_id, s.id AS id, s."startedAt", s."endedAt", s."canceledAt",
        s.tier, s."interval", s."amountCents", s.currency,
        ARRAY[s.id] AS path
      FROM "Subscription" s
      WHERE s."organizationId" = ${organizationId}
        AND s."previousSubscriptionId" IS NULL      -- chain head = lifecycle start
      UNION ALL
      SELECT
        w.root_id, s.id, s."startedAt", s."endedAt", s."canceledAt",
        s.tier, s."interval", s."amountCents", s.currency,
        w.path || s.id
      FROM chain_walk w
      JOIN "Subscription" s
        ON s."previousSubscriptionId" = w.id        -- 1:1 hand-off, enforced by @unique
       AND s."organizationId" = ${organizationId}   -- tenant filter inside the recursion
      WHERE NOT (s.id = ANY(w.path))                -- cycle guard for malformed data
    ),
    chain_roots AS (
      SELECT root_id, id, "startedAt", "endedAt", "canceledAt",
             tier, "interval", "amountCents", currency
      FROM chain_walk
      ${projection}
    )`;
}

interface MRRByCurrencyRow {
  currency: string;
  mrr_cents: NumericLike;
  subscription_count: NumericLike;
}

/**
 * MRR + live-subscription count as of an instant, bucketed by currency.
 * Returns a PrismaPromise so callers can batch several of these in one round trip.
 */
function mrrByCurrencyQuery(
  organizationId: string,
  asOf: Date,
): Prisma.PrismaPromise<MRRByCurrencyRow[]> {
  return prisma.$queryRaw<MRRByCurrencyRow[]>(Prisma.sql`
    SELECT
      s.currency AS currency,
      COALESCE(SUM(${normalizedMonthlyCents("s")}), 0)::bigint AS mrr_cents,
      COUNT(*)::int AS subscription_count
    FROM "Subscription" s
    WHERE s."organizationId" = ${organizationId}
      AND ${activeAsOf(asOf)}
    GROUP BY s.currency
    ORDER BY 2 DESC
  `);
}

interface ChurnRow {
  active_at_start: NumericLike;
  churned: NumericLike;
}

/**
 * Churn numerator + denominator in one pass.
 *
 * Denominator: segments live as of `start`.
 * Numerator:   those same segments whose `canceledAt` lands in `(start, end]`.
 *
 * `canceledAt` is the right field (not `endedAt`): the seed sets it ONLY for a real
 * customer cancellation and leaves it NULL when a segment ends because of a
 * plan change, so an upgrade never registers as churn. Restricting the numerator to
 * the opening cohort keeps the ratio in [0, 1] and prevents a same-period
 * signup-then-cancel from producing a rate above 100%.
 */
function churnQuery(organizationId: string, period: ResolvedPeriod): Prisma.PrismaPromise<ChurnRow[]> {
  const liveAtStart = Prisma.sql`
    s."startedAt" <= ${ts(period.start)}
    AND (s."endedAt" IS NULL OR s."endedAt" > ${ts(period.start)})`;

  return prisma.$queryRaw<ChurnRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE ${liveAtStart})::int AS active_at_start,
      COUNT(*) FILTER (
        WHERE ${liveAtStart}
          AND s."canceledAt" IS NOT NULL
          AND s."canceledAt" > ${ts(period.start)}
          AND s."canceledAt" <= ${ts(period.end)}
      )::int AS churned
    FROM "Subscription" s
    WHERE s."organizationId" = ${organizationId}
  `);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Current MRR in integer cents, from the subscriptions live at `asOf`.
 * Empty org / no live subscriptions => 0 cents, default currency, 0 subscriptions.
 */
export async function getMRR(organizationId: string, asOf: Date = new Date()): Promise<MRRResult> {
  const rows = await mrrByCurrencyQuery(organizationId, asOf);

  // At most one row per distinct currency (realistically 1) — not a table scan.
  let mrrCents = 0;
  let activeSubscriptions = 0;
  for (const row of rows) {
    mrrCents += toNumber(row.mrr_cents);
    activeSubscriptions += toNumber(row.subscription_count);
  }

  return {
    organizationId,
    asOf,
    mrrCents,
    currency: rows[0]?.currency ?? DEFAULT_CURRENCY,
    isMixedCurrency: rows.length > 1,
    activeSubscriptions,
  };
}

/** ARR, derived as MRR x 12. */
export async function getARR(organizationId: string, asOf: Date = new Date()): Promise<ARRResult> {
  const mrr = await getMRR(organizationId, asOf);
  return {
    organizationId,
    asOf,
    arrCents: mrr.mrrCents * MONTHS_PER_YEAR,
    mrrCents: mrr.mrrCents,
    currency: mrr.currency,
    isMixedCurrency: mrr.isMixedCurrency,
  };
}

/**
 * Subscription churn rate for a period.
 * Zero subscriptions at period start => `rate: null` (undefined, not 0).
 */
export async function getChurnRate(
  organizationId: string,
  period: Period,
): Promise<ChurnRateResult> {
  const resolved = resolvePeriod(period);
  const [row] = await churnQuery(organizationId, resolved);

  const activeAtPeriodStart = toNumber(row?.active_at_start ?? 0);
  const churnedInPeriod = toNumber(row?.churned ?? 0);

  return {
    organizationId,
    period: resolved,
    activeAtPeriodStart,
    churnedInPeriod,
    rate: activeAtPeriodStart === 0 ? null : churnedInPeriod / activeAtPeriodStart,
  };
}

/**
 * Net revenue retention over a period.
 *
 * COHORT: the subscriptions live as of `period.start`. NRR only ever looks at that
 * opening cohort — revenue from subscriptions acquired during the period is
 * deliberately excluded, which is what separates NRR from plain growth.
 *
 * Following the cohort forward is the hard part, because a plan change is modelled as
 * "end segment A, open segment B". A naive per-row comparison would score every
 * upgrade as 100% churn plus a brand-new customer. So the query walks the hand-off
 * chain with a recursive CTE, hopping `B.previousSubscriptionId = A.id`. Each cohort
 * member's ending MRR is the MRR of the node in its own chain that is live at
 * `period.end`; 0 means the customer actually left.
 *
 * The walk recurses on the FK, NOT on `B.startedAt = A.endedAt` (which is what this
 * used to do). Timestamp-equality matching was wrong three ways: it is not 1:1, so a
 * root could fan out into several branches (only one was counted, the rest silently
 * dropped) and several roots could fan in to one successor (counted once per root, so
 * ending MRR was inflated); it enumerated every root-to-node PATH, which is
 * exponential (49 subscription rows produced ~33M chain rows); and it required
 * millisecond-identical values, so any clock drift between writing `endedAt` and
 * `startedAt` turned every plan change into a churn event.
 *
 * `Subscription.previousSubscriptionId` is `@unique`, which makes the hand-off graph a
 * forest of simple paths: at most one predecessor per row (one FK column) and at most
 * one successor per row (the unique index). Fan-out and fan-in are therefore
 * unrepresentable, every node belongs to exactly one root's chain, and no depth cap or
 * "pick the deepest live node" tiebreak is needed. A `path` array still guards against
 * cycles so malformed data cannot loop forever.
 *
 * Then, per cohort member: delta > 0 is expansion, delta < 0 is contraction, and a
 * 0 ending MRR is churn — which makes the identity
 *   ending = starting + expansion - contraction - churn
 * hold exactly, and NRR = ending / starting.
 *
 * COHORT = PAYING SEGMENTS ONLY (collision C1). A segment whose normalized MRR is 0 at
 * `period.start` — a FREE tier, or any zero-amount row — is not in the cohort. It used
 * to be, and converting it to paid then showed up as `expansion` on a cohort with 0
 * starting MRR, so the caller got a positive expansion figure next to `nrr: null`.
 * `getRevenueMovement` classifies those same dollars as NEW business, and two pages
 * disagreeing about one payment is worse than either answer alone. Free-to-paid is an
 * acquisition; only a customer who was already paying can expand.
 *
 * Empty cohort (no paying subscriptions at `period.start`) => `nrr: null`.
 *
 * KNOWN LIMIT: a genuine 1-to-many split (one subscription becoming two) cannot be
 * expressed, by design — that ambiguity is exactly what produced the double-counting.
 * Supporting splits would need explicit allocation semantics, not a looser link.
 */
export async function getNetRevenueRetention(
  organizationId: string,
  period: Period,
): Promise<NetRevenueRetentionResult> {
  const resolved = resolvePeriod(period);
  const startTs = ts(resolved.start);
  const endTs = ts(resolved.end);

  interface NRRRow {
    cohort_size: NumericLike;
    starting_mrr_cents: NumericLike;
    ending_mrr_cents: NumericLike;
    expansion_mrr_cents: NumericLike;
    contraction_mrr_cents: NumericLike;
    churned_mrr_cents: NumericLike;
  }

  const rows = await prisma.$queryRaw<NRRRow[]>(Prisma.sql`
    WITH RECURSIVE cohort AS (
      SELECT s.id, s."startedAt", s."endedAt", s."canceledAt", s."interval", s."amountCents", s.tier
      FROM "Subscription" s
      WHERE s."organizationId" = ${organizationId}
        AND ${liveAsOf("s", startTs)}
        -- Collision C1: the cohort is PAYING subscriptions only. A FREE-tier segment has
        -- 0 starting MRR, so converting it to paid used to register as "expansion" on a
        -- cohort whose starting MRR was 0 -- i.e. expansion alongside a null NRR, which
        -- is not a reading anyone can act on. Worse, getRevenueMovement books the very
        -- same dollars as NEW business, so the Retention and Revenue pages would have
        -- disagreed about what those dollars were. Free-to-paid is an ACQUISITION, not
        -- expansion of an existing paying customer, which is also the usual SaaS
        -- convention. Excluding the row here is what makes the two pages agree.
        AND ${normalizedMonthlyCents("s")} > 0
    ),
    chain AS (
      SELECT
        c.id AS root_id, c.id AS node_id, c."startedAt", c."endedAt", c."canceledAt",
        c."interval", c."amountCents", c.tier,
        ARRAY[c.id] AS path
      FROM cohort c
      UNION ALL
      SELECT
        ch.root_id, s.id, s."startedAt", s."endedAt", s."canceledAt",
        s."interval", s."amountCents", s.tier,
        ch.path || s.id
      FROM chain ch
      JOIN "Subscription" s
        ON s."previousSubscriptionId" = ch.node_id   -- 1:1 hand-off, enforced by @unique
       AND s."organizationId" = ${organizationId}    -- tenant filter inside the recursion
      WHERE ch."endedAt" IS NOT NULL                 -- a live segment has no successor
        AND ch."canceledAt" IS NULL                  -- superseded, not cancelled
        AND ch."endedAt" <= ${endTs}                 -- do not walk past the period end
        AND NOT (s.id = ANY(ch.path))                -- cycle guard for malformed data
    ),
    per_root AS (
      SELECT
        c.id AS root_id,
        ${normalizedMonthlyCents("c")} AS start_mrr,
        -- SUM, not "ORDER BY depth DESC LIMIT 1". The @unique link means a chain is a
        -- simple path with contiguous, disjoint segments, so exactly one node is live
        -- at the period end and the sum equals that node. Summing is nonetheless the
        -- right reduction: it is deterministic, it cannot raise "more than one row
        -- returned by a subquery", and if a chain ever did hold two concurrently-live
        -- nodes their combined MRR is the honest ending value. Picking the deepest
        -- node was neither: it silently preferred a longer branch over a paying one.
        COALESCE((
          SELECT SUM(${normalizedMonthlyCents("ch")})
          FROM chain ch
          WHERE ch.root_id = c.id
            AND ${liveAsOf("ch", endTs)}
        ), 0) AS end_mrr
      FROM cohort c
    )
    SELECT
      COUNT(*)::int AS cohort_size,
      COALESCE(SUM(start_mrr), 0)::bigint AS starting_mrr_cents,
      COALESCE(SUM(end_mrr), 0)::bigint AS ending_mrr_cents,
      -- "<> 0", not "> 0": a negative end_mrr (a credit row) would otherwise be
      -- excluded from expansion, contraction AND churn while still landing in the
      -- ending total, breaking the identity. A CHECK constraint on amountCents makes
      -- that unrepresentable, but the aggregate should not depend on it.
      COALESCE(SUM(GREATEST(end_mrr - start_mrr, 0)) FILTER (WHERE end_mrr <> 0), 0)::bigint
        AS expansion_mrr_cents,
      COALESCE(SUM(GREATEST(start_mrr - end_mrr, 0)) FILTER (WHERE end_mrr <> 0), 0)::bigint
        AS contraction_mrr_cents,
      COALESCE(SUM(start_mrr) FILTER (WHERE end_mrr = 0), 0)::bigint AS churned_mrr_cents
    FROM per_root
  `);

  const row = rows[0];
  const startingMRRCents = toNumber(row?.starting_mrr_cents ?? 0);
  const endingMRRCents = toNumber(row?.ending_mrr_cents ?? 0);

  return {
    organizationId,
    period: resolved,
    cohortSize: toNumber(row?.cohort_size ?? 0),
    startingMRRCents,
    endingMRRCents,
    expansionMRRCents: toNumber(row?.expansion_mrr_cents ?? 0),
    contractionMRRCents: toNumber(row?.contraction_mrr_cents ?? 0),
    churnedMRRCents: toNumber(row?.churned_mrr_cents ?? 0),
    nrr: startingMRRCents === 0 ? null : endingMRRCents / startingMRRCents,
  };
}

/**
 * Live subscription count at `asOf`, broken down by plan tier (and by terminal
 * status, which is informational only). Two grouped aggregates batched into a
 * single round trip; nothing is counted in JS beyond summing <= 4 group rows.
 * Empty org => total 0 with empty breakdowns.
 */
export async function getActiveSubscriptions(
  organizationId: string,
  asOf: Date = new Date(),
): Promise<ActiveSubscriptionsResult> {
  const where: Prisma.SubscriptionWhereInput = {
    organizationId,
    startedAt: { lte: asOf },
    OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
  };

  // Held in consts so Prisma's groupBy generics resolve before `$transaction`
  // widens the tuple; inlining them degrades `_count` to a union.
  const tierQuery = prisma.subscription.groupBy({
    by: ["tier"],
    where,
    _count: { _all: true },
    orderBy: { tier: "asc" },
  });
  const statusQuery = prisma.subscription.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
    orderBy: { status: "asc" },
  });

  const [tierGroups, statusGroups] = await prisma.$transaction([tierQuery, statusQuery]);

  const byTier: PlanTierCount[] = tierGroups
    .map((group) => ({ tier: group.tier, count: group._count._all }))
    .sort((a, b) => b.count - a.count);

  const byStatus: SubscriptionStatusCount[] = statusGroups
    .map((group) => ({ status: group.status, count: group._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    organizationId,
    asOf,
    total: byTier.reduce((sum, entry) => sum + entry.count, 0),
    byTier,
    byStatus,
  };
}

/**
 * Month-by-month MRR series for a chart, read from `MetricSnapshot`.
 *
 * The window ends at the org's most recent snapshot (not at "now"), so the chart
 * always terminates on real data instead of trailing off into empty months, and
 * spans `months` calendar months back from there. Point-in-time values (MRR, active
 * subs) come from the last snapshot of each month; flow values (new/churned subs)
 * are summed across the month. Months with no snapshot are omitted rather than
 * fabricated as zeros — a gap is data, a zero is a lie.
 *
 * No snapshots for the org => `[]`. `months <= 0` => `[]` (zero months of history is
 * zero points, not one). `months` is defended like `getRecentInvoices`'s `limit`
 * because it typically arrives from a parsed query param: `NaN` used to survive
 * `Math.trunc`/`min`/`max` untouched and bind straight into `$n::int`, which Postgres
 * rejects with `invalid input syntax for type integer: "NaN"` — a 500, not an empty
 * chart.
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
    active_subs: NumericLike;
    new_subs: NumericLike;
    churned_subs: NumericLike;
  }

  const rows = await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
    WITH bounds AS (
      SELECT MAX("date") AS latest
      FROM "MetricSnapshot"
      WHERE "organizationId" = ${organizationId}
    )
    SELECT
      to_char(date_trunc('month', m."date"), 'YYYY-MM')          AS month,
      to_char(MAX(m."date"), 'YYYY-MM-DD')                        AS as_of_date,
      (array_agg(m."mrrCents"   ORDER BY m."date" DESC))[1]::int  AS mrr_cents,
      (array_agg(m."activeSubs" ORDER BY m."date" DESC))[1]::int  AS active_subs,
      SUM(m."newSubs")::int                                       AS new_subs,
      SUM(m."churnedSubs")::int                                   AS churned_subs
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
    activeSubs: toNumber(row.active_subs),
    newSubs: toNumber(row.new_subs),
    churnedSubs: toNumber(row.churned_subs),
  }));
}

/**
 * Invoice history, newest first, with each invoice's subscription tier fetched in the
 * same round trip (no per-row lookup).
 *
 * The tenant filter is applied twice on purpose: directly on `Invoice`, and again on
 * the joined `Subscription`. An invoice whose subscription belongs to another org is
 * corrupt data, and it must not leak through the relation.
 *
 * Paging is KEYSET, not `skip`/`offset`: the ordering `[issuedAt desc, id desc]` is
 * total (the `id` tiebreak makes same-instant rows deterministic), so a cursor is
 * stable under concurrent inserts and costs the same on page 50 as on page 1. Ask for
 * `take + 1` rows to learn whether another page exists without a second count query.
 *
 * `period` filters `issuedAt` on the file's `(start, end]` convention — an invoice is
 * an EVENT, so it belongs to the period its issue instant falls in, and an invoice
 * issued exactly at a boundary lands in the earlier period and only there.
 *
 * No invoices => `{ invoices: [], nextCursor: null }`.
 */
export async function getInvoices(
  organizationId: string,
  options: InvoiceListOptions = {},
): Promise<InvoiceListResult> {
  const take = Math.max(1, Math.min(Math.trunc(options.limit ?? 10) || 1, 100));

  // Collected into an AND list so each filter composes without clobbering the others —
  // in particular the keyset OR, which must not become a top-level OR beside the
  // tenant filter or it would widen the query across organizations.
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
      subscription: { is: { organizationId } },
      ...(filters.length > 0 ? { AND: filters } : {}),
    },
    // `id` breaks ties so pagination/ordering is deterministic for same-instant rows.
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      amountCents: true,
      currency: true,
      status: true,
      issuedAt: true,
      paidAt: true,
      subscription: { select: { id: true, tier: true, interval: true } },
    },
  });

  const invoices = rows.slice(0, take);
  const last = invoices[invoices.length - 1];

  return {
    invoices,
    nextCursor:
      rows.length > take && last !== undefined
        ? { issuedAt: last.issuedAt, id: last.id }
        : null,
  };
}

/**
 * The newest `limit` invoices. Thin wrapper over `getInvoices` kept for the overview,
 * whose shape (a bare array) is all it needs.
 *
 * No invoices => `[]`.
 */
export async function getRecentInvoices(
  organizationId: string,
  limit: number = 10,
): Promise<RecentInvoice[]> {
  const { invoices } = await getInvoices(organizationId, { limit });
  return invoices;
}

/** (current - previous) / previous as a fraction; null when previous is 0. */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * Headline KPIs with period-over-period comparison.
 *
 * MRR / ARR / active subscriptions are STATE, measured as of each period's `end`;
 * churn is a FLOW, computed over each period. All four queries are batched into one
 * `$transaction` at REPEATABLE READ so every number comes from the same database
 * snapshot. The isolation level is not decoration: at the default READ COMMITTED each
 * statement in the batch takes its own snapshot, so a concurrent write between the
 * current-MRR and previous-MRR queries would produce a comparison against two
 * different states of the world. These are all read-only, so REPEATABLE READ cannot
 * raise a serialization failure here.
 *
 * The period is resolved ONCE and `previous` is derived from that resolved value —
 * see `previousOfResolved` for why calling `resolvePeriod` twice is a bug.
 *
 * `changePct` is null wherever the previous value is 0 or the metric is undefined
 * (see `MetricComparison`). Churn additionally reports `changePoints`, which is the
 * meaningful delta for a rate.
 */
export async function getMetricsSummary(
  organizationId: string,
  period: Period = { kind: "preset", preset: "last_30_days" },
): Promise<MetricsSummary> {
  const current = resolvePeriod(period);
  const previous = previousOfResolved(period, current);

  const [currentMRRRows, previousMRRRows, currentChurnRows, previousChurnRows] =
    await prisma.$transaction(
      [
        mrrByCurrencyQuery(organizationId, current.end),
        mrrByCurrencyQuery(organizationId, previous.end),
        churnQuery(organizationId, current),
        churnQuery(organizationId, previous),
      ],
      { isolationLevel: "RepeatableRead" },
    );

  const foldMRR = (rows: MRRByCurrencyRow[]): { cents: number; subs: number } =>
    rows.reduce(
      (acc, row) => ({
        cents: acc.cents + toNumber(row.mrr_cents),
        subs: acc.subs + toNumber(row.subscription_count),
      }),
      { cents: 0, subs: 0 },
    );

  const currentMRR = foldMRR(currentMRRRows);
  const previousMRR = foldMRR(previousMRRRows);

  const rateOf = (rows: ChurnRow[]): number | null => {
    const denominator = toNumber(rows[0]?.active_at_start ?? 0);
    if (denominator === 0) return null;
    return toNumber(rows[0]?.churned ?? 0) / denominator;
  };

  const currentChurn = rateOf(currentChurnRows);
  const previousChurn = rateOf(previousChurnRows);

  const churnChangePct =
    currentChurn === null || previousChurn === null
      ? null
      : percentChange(currentChurn, previousChurn);

  return {
    organizationId,
    period: current,
    previousPeriod: previous,
    currency: currentMRRRows[0]?.currency ?? DEFAULT_CURRENCY,
    isMixedCurrency: currentMRRRows.length > 1,
    mrrCents: {
      current: currentMRR.cents,
      previous: previousMRR.cents,
      changePct: percentChange(currentMRR.cents, previousMRR.cents),
    },
    arrCents: {
      current: currentMRR.cents * MONTHS_PER_YEAR,
      previous: previousMRR.cents * MONTHS_PER_YEAR,
      // Identical to the MRR change: ARR is a constant multiple of MRR.
      changePct: percentChange(currentMRR.cents, previousMRR.cents),
    },
    activeSubscriptions: {
      current: currentMRR.subs,
      previous: previousMRR.subs,
      changePct: percentChange(currentMRR.subs, previousMRR.subs),
    },
    churnRate: {
      current: currentChurn,
      previous: previousChurn,
      changePct: churnChangePct,
      changePoints:
        currentChurn === null || previousChurn === null ? null : currentChurn - previousChurn,
    },
  };
}

// ---------------------------------------------------------------------------
// User activity (from MetricSnapshot)
// ---------------------------------------------------------------------------

export interface UserActivitySummary {
  readonly period: ResolvedPeriod;
  readonly previousPeriod: ResolvedPeriod;
  /**
   * Active users as of each period's `end`: the latest snapshot on or before that
   * UTC day. `null` when the org has no snapshot that early.
   *
   * NOTE: `MetricSnapshot.activeUsers` is an ESTIMATE — a per-tier seat count on
   * live plans (lib/snapshot-formula.ts). The schema stores no logins or usage.
   */
  readonly activeUsers: MetricComparison<number | null>;
  /** Net seats added over each period: the sum of daily `newUsers` in (start, end]. */
  readonly newUsers: MetricComparison<number>;
  /**
   * `YYYY-MM-DD` of the snapshot `activeUsers.current` comes from, or null.
   * Earlier than `period.end` whenever the daily snapshot job has not caught up —
   * worth saying, because a stale seat count looks exactly like a current one.
   */
  readonly asOfDate: string | null;
}

interface UserActivityRow {
  active_users: NumericLike;
  as_of_date: string | null;
  new_users: NumericLike;
}

/**
 * State and flow for one period, in one statement.
 *
 * Snapshot `date` is a UTC calendar day whose row describes that day's midnight
 * (see lib/snapshot-formula.ts). So the state as of an instant is the latest day
 * `<=` its UTC date, and the flow over `(start, end]` is the days strictly after
 * `start`'s date up to and including `end`'s — the same half-open convention as
 * every other period query in this file.
 */
function userActivityQuery(
  organizationId: string,
  period: ResolvedPeriod,
): Prisma.PrismaPromise<UserActivityRow[]> {
  return prisma.$queryRaw<UserActivityRow[]>(Prisma.sql`
    WITH latest AS (
      SELECT m."activeUsers", m."date"
      FROM "MetricSnapshot" m
      WHERE m."organizationId" = ${organizationId}
        AND m."date" <= ${ts(period.end)}::date
      ORDER BY m."date" DESC
      LIMIT 1
    )
    SELECT
      (SELECT "activeUsers" FROM latest)::int                      AS active_users,
      (SELECT to_char("date", 'YYYY-MM-DD') FROM latest)           AS as_of_date,
      COALESCE((
        SELECT SUM(m."newUsers")
        FROM "MetricSnapshot" m
        WHERE m."organizationId" = ${organizationId}
          AND m."date" > ${ts(period.start)}::date
          AND m."date" <= ${ts(period.end)}::date
      ), 0)::int                                                   AS new_users
  `);
}

/**
 * Active and new users with period-over-period comparison — the same shape and
 * the same period handling as `getMetricsSummary`, so the overview's user tiles
 * compare against exactly the window its other tiles do. Both periods are read in
 * one REPEATABLE READ transaction for the same reason given there.
 */
export async function getUserActivity(
  organizationId: string,
  period: Period = { kind: "preset", preset: "last_30_days" },
): Promise<UserActivitySummary> {
  const current = resolvePeriod(period);
  const previous = previousOfResolved(period, current);

  const [currentRows, previousRows] = await prisma.$transaction(
    [userActivityQuery(organizationId, current), userActivityQuery(organizationId, previous)],
    { isolationLevel: "RepeatableRead" },
  );

  const activeOf = (rows: UserActivityRow[]): number | null => {
    const value = rows[0]?.active_users ?? null;
    return value === null ? null : toNumber(value);
  };

  const currentActive = activeOf(currentRows);
  const previousActive = activeOf(previousRows);
  const currentNew = toNumber(currentRows[0]?.new_users ?? 0);
  const previousNew = toNumber(previousRows[0]?.new_users ?? 0);

  return {
    period: current,
    previousPeriod: previous,
    activeUsers: {
      current: currentActive,
      previous: previousActive,
      changePct:
        currentActive === null || previousActive === null
          ? null
          : percentChange(currentActive, previousActive),
    },
    newUsers: {
      current: currentNew,
      previous: previousNew,
      changePct: percentChange(currentNew, previousNew),
    },
    asOfDate: currentRows[0]?.as_of_date ?? null,
  };
}
// ---------------------------------------------------------------------------
// Month-bucketed series
//
// COLLISION C3 — WHICH INSTANT IS "MONTH END"?
//
// Two defensible conventions existed and they disagree by real money:
//
//   (A) The last SNAPSHOT of the month. This is what getMRRTrend does: it reads
//       MetricSnapshot and takes the newest row in each calendar month, so June is
//       measured as of 2026-06-30 and the in-progress month as of whenever the rollup
//       last ran.
//   (B) The month BOUNDARY instant, 00:00:00 UTC on the 1st. June closes at
//       2026-07-01T00:00:00Z.
//
// Everything below uses (B). Three reasons:
//
//   1. Only (B) partitions time. Consecutive windows under (B) are exactly contiguous
//      and gapless, which is precisely the (start, end] guarantee the rest of this file
//      already makes, so a cancellation is attributed to exactly one month. Under (A)
//      the gap between measurement points is 30 days, then 31, then however many days
//      into the current month the rollup has reached — buckets that are not months but
//      are labelled as months.
//   2. (B) measures state at a calendar instant rather than at "whenever the snapshot
//      job last succeeded", so a late or missed rollup cannot move a historical figure.
//   3. These functions read Subscription, the source of truth, so they do not inherit
//      MetricSnapshot's freshness. (B) costs nothing to compute here.
//
// CONSEQUENCE, stated plainly: getRevenueMovement's endingMRRCents for month M equals
// getMRRTrend's mrrCents for month M only when no segment starts or ends in the
// interval (last snapshot of M, first instant of M+1]. Since snapshots are daily, that
// interval is a single day, so the two agree on every month EXCEPT one containing a
// segment whose startedAt or endedAt falls exactly on the 1st of the following month.
// Measured against the current seed they agree on all comparable months, because the
// seed places every lifecycle event on day 16. A segment ending exactly on 2026-07-01
// makes June differ by that segment's MRR.
//
// Reconciling them on EVERY month would mean re-expressing getMRRTrend on month
// boundaries. That is a change to an existing, already-shipped function used by the
// overview, so it is deliberately NOT done here.
// ---------------------------------------------------------------------------

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
  paying_chains_at_start: NumericLike;
}

/**
 * The revenue bridge: where each month's MRR came from and where it went.
 *
 * Attribution is per LIFECYCLE (chain), not per segment — see the CHAIN VS SEGMENT note
 * on RevenueMovementPoint. That is the whole point: a customer upgrading from PRO to
 * ENTERPRISE ends one segment and starts another, and a per-segment reading would call
 * that a churn plus an acquisition. Walking previousSubscriptionId instead makes it one
 * chain whose MRR went up, which is expansion.
 *
 * One recursive pass labels every segment with its chain root; month boundaries are then
 * cross-joined and LEAD compares each chain against itself one month later. There is no
 * per-month recursion and no query in a loop.
 *
 * Bucketing per chain, from prev (MRR at the opening boundary) to next:
 *   prev = 0, next > 0, never billed before  -> new
 *   prev = 0, next > 0, billed before        -> reactivation
 *   prev > 0, next > prev                    -> expansion
 *   prev > 0, 0 < next < prev                -> contraction
 *   prev > 0, next = 0                       -> churned
 * which makes the identity
 *   ending = starting + new + reactivation + expansion - contraction - churned
 * hold exactly. The partition is exhaustive because normalized MRR is never negative —
 * the CHECK constraint amountCents >= 0 (added in migration
 * 20260816121500_subscription_handoff_link_and_metric_indexes) is what guarantees that.
 *
 * Rows are labelled by the OPENING month (collision C4): the movement between
 * 2026-04-01 and 2026-05-01 is April's, and labelling it by its closing boundary would
 * report April's acquisitions in May and disagree with getMRRTrend's month labels.
 *
 * REACTIVATION IS CHAIN-SCOPED, and that is a real limit. A customer who cancels
 * outright and returns later starts a NEW chain (nothing links across a cancellation),
 * so they are counted as new, not reactivation. Only a lifecycle that stayed linked
 * while its MRR passed through 0 — a downgrade to FREE and back — lands in
 * reactivation. Telling a genuinely new customer from a returning one needs a customer
 * entity the schema does not have.
 *
 * `months <= 0`, or an org with no subscriptions => `[]`.
 */
export async function getRevenueMovement(
  organizationId: string,
  months: number = DEFAULT_TREND_MONTHS,
  asOf: Date = new Date(),
): Promise<RevenueMovementPoint[]> {
  const span = clampMonths(months);
  if (span === 0) return [];
  const window = monthWindow(span, asOf);

  const rows = await prisma.$queryRaw<RevenueMovementRow[]>(Prisma.sql`
    WITH RECURSIVE ${chainRootsCte(organizationId, {
      start: window.firstBoundary,
      end: window.asOf,
    })},
    ${monthBoundariesCte(window)},
    root_facts AS (
      SELECT
        r.root_id,
        -- The first instant this lifecycle ever billed. Tells a first-ever activation
        -- from a return, independently of where the window happens to start.
        MIN(r."startedAt") FILTER (WHERE ${normalizedMonthlyCents("r")} > 0) AS first_paid_at
      FROM chain_roots r
      GROUP BY r.root_id
    ),
    per_root_boundary AS (
      SELECT
        b.boundary,
        r.root_id,
        COALESCE(SUM(${normalizedMonthlyCents("r")}) FILTER (
          WHERE ${liveAsOf("r", Prisma.raw("b.boundary"))}
        ), 0) AS mrr
      FROM boundaries b
      CROSS JOIN chain_roots r
      GROUP BY b.boundary, r.root_id
    ),
    stepped AS (
      SELECT
        p.boundary, p.root_id, p.mrr, f.first_paid_at,
        LEAD(p.mrr)      OVER (PARTITION BY p.root_id ORDER BY p.boundary) AS next_mrr,
        LEAD(p.boundary) OVER (PARTITION BY p.root_id ORDER BY p.boundary) AS next_boundary
      FROM per_root_boundary p
      JOIN root_facts f ON f.root_id = p.root_id
    )
    SELECT
      to_char(st.boundary, 'YYYY-MM')                            AS month,
      st.boundary                                                AS period_start,
      MIN(st.next_boundary)                                      AS period_end,
      (MIN(st.next_boundary) = st.boundary + INTERVAL '1 month') AS is_complete,
      COALESCE(SUM(st.mrr), 0)::bigint                           AS starting_mrr_cents,
      COALESCE(SUM(st.next_mrr), 0)::bigint                      AS ending_mrr_cents,
      COALESCE(SUM(st.next_mrr) FILTER (
        WHERE st.mrr = 0 AND st.next_mrr > 0 AND st.first_paid_at > st.boundary), 0)::bigint
        AS new_mrr_cents,
      COALESCE(SUM(st.next_mrr) FILTER (
        WHERE st.mrr = 0 AND st.next_mrr > 0 AND st.first_paid_at <= st.boundary), 0)::bigint
        AS reactivation_mrr_cents,
      COALESCE(SUM(st.next_mrr - st.mrr) FILTER (
        WHERE st.mrr > 0 AND st.next_mrr > st.mrr), 0)::bigint
        AS expansion_mrr_cents,
      COALESCE(SUM(st.mrr - st.next_mrr) FILTER (
        WHERE st.mrr > 0 AND st.next_mrr < st.mrr AND st.next_mrr > 0), 0)::bigint
        AS contraction_mrr_cents,
      COALESCE(SUM(st.mrr) FILTER (
        WHERE st.mrr > 0 AND st.next_mrr = 0), 0)::bigint
        AS churned_mrr_cents,
      COUNT(*) FILTER (WHERE st.mrr > 0)::int                    AS paying_chains_at_start
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
      payingChainsAtStart: toNumber(row.paying_chains_at_start),
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
  active_at_start: NumericLike;
  churned: NumericLike;
}

/**
 * Subscription churn rate, month by month.
 *
 * Computed from Subscription, NOT from MetricSnapshot (collision C2). The snapshot
 * rollup's churnedSubs counts EVERY cancellation in a day; getChurnRate counts only
 * cancellations of segments that were already live at the period start. Those are
 * different numbers — a subscription that starts and cancels inside the same month is
 * in the snapshot figure and in neither period's cohort — so a snapshot-derived churn
 * rate would sit on the Retention page contradicting getChurnRate on the Overview.
 * This reproduces getChurnRate's cohort attribution exactly, once per month, so
 * getChurnRateTrend(org)[i] equals getChurnRate(org, { kind: "range", start, end })
 * for that month's boundaries.
 *
 * Month windows follow the C3 convention: (month start, next month start], contiguous
 * and gapless, so a cancellation lands in exactly one month and never in two.
 *
 * activeAtStart counts SEGMENTS, not customers — see the CHAIN VS SEGMENT note on
 * RevenueMovementPoint. It is the same denominator getChurnRate uses and includes
 * FREE-tier segments, because this measures subscription churn, not revenue churn.
 *
 * Unlike getRevenueMovement, an org with no subscriptions still yields one row per
 * month with `rate: null`. A churn chart of explicit "undefined" months is honest; an
 * empty array would be indistinguishable from "the query failed".
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

  const liveAtStart = liveAsOf("s", Prisma.raw("w.start_at"));

  const rows = await prisma.$queryRaw<ChurnTrendRow[]>(Prisma.sql`
    WITH ${monthBoundariesCte(window)},
    windows AS (
      SELECT
        boundary AS start_at,
        LEAD(boundary) OVER (ORDER BY boundary) AS end_at
      FROM boundaries
    )
    SELECT
      to_char(w.start_at, 'YYYY-MM')                        AS month,
      w.start_at                                            AS start_at,
      w.end_at                                              AS end_at,
      (w.end_at = w.start_at + INTERVAL '1 month')          AS is_complete,
      COUNT(s.id) FILTER (WHERE ${liveAtStart})::int        AS active_at_start,
      COUNT(s.id) FILTER (
        WHERE ${liveAtStart}
          AND s."canceledAt" IS NOT NULL
          AND s."canceledAt" > w.start_at
          AND s."canceledAt" <= w.end_at
      )::int                                                AS churned
    FROM windows w
    LEFT JOIN "Subscription" s ON s."organizationId" = ${organizationId}
    WHERE w.end_at IS NOT NULL
    GROUP BY w.start_at, w.end_at
    ORDER BY w.start_at ASC
  `);

  return rows.map((row) => {
    const activeAtStart = toNumber(row.active_at_start);
    const churned = toNumber(row.churned);
    return {
      month: row.month,
      period: { start: row.start_at, end: row.end_at },
      isComplete: row.is_complete,
      activeAtStart,
      churned,
      rate: activeAtStart === 0 ? null : churned / activeAtStart,
    };
  });
}

interface InvoiceTotalsRow {
  currency: string;
  status: InvoiceStatus;
  issued_count: NumericLike;
  issued_cents: NumericLike;
  collected_cents: NumericLike;
  outstanding_cents: NumericLike;
}

/**
 * Collected vs outstanding invoice money for a period.
 *
 * The two headline figures are deliberately measured on DIFFERENT populations, because
 * they answer different questions and conflating them is how a dashboard ends up
 * claiming it collected money it merely billed:
 *
 *   - collectedCents is a FLOW, bucketed by paidAt in (start, end]. Cash that arrived
 *     during the period, whenever the invoice was raised. An invoice issued in March
 *     and paid in April is April's collection.
 *   - outstandingCents is a STOCK, every OPEN invoice issued at or before period.end.
 *     It deliberately reaches back before the period: an unpaid invoice from two months
 *     ago is still outstanding today, and dropping it would understate the balance.
 *   - issuedCents and byStatus cover invoices ISSUED in (start, end] — the period's own
 *     billing, whatever became of it.
 *
 * One grouped scan over the org's invoices with FILTERed aggregates; the folding in JS
 * runs over at most (currencies x statuses) rows, never over invoices.
 *
 * Tenant filter applied twice, as in getInvoices: on Invoice directly and again on the
 * joined Subscription, so a mis-parented invoice cannot leak across orgs.
 *
 * No invoices => zeroes, default currency, empty byStatus.
 */
export async function getInvoiceTotals(
  organizationId: string,
  period: Period,
): Promise<InvoiceTotals> {
  const resolved = resolvePeriod(period);
  const startTs = ts(resolved.start);
  const endTs = ts(resolved.end);

  const issuedInPeriod = Prisma.sql`i."issuedAt" > ${startTs} AND i."issuedAt" <= ${endTs}`;

  const rows = await prisma.$queryRaw<InvoiceTotalsRow[]>(Prisma.sql`
    SELECT
      i.currency AS currency,
      i.status   AS status,
      COUNT(*) FILTER (WHERE ${issuedInPeriod})::int AS issued_count,
      COALESCE(SUM(i."amountCents") FILTER (WHERE ${issuedInPeriod}), 0)::bigint
        AS issued_cents,
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
    JOIN "Subscription" s
      ON s.id = i."subscriptionId"
     AND s."organizationId" = ${organizationId}
    WHERE i."organizationId" = ${organizationId}
    GROUP BY i.currency, i.status
  `);

  let collectedCents = 0;
  let outstandingCents = 0;
  let issuedCents = 0;
  const byStatus = new Map<InvoiceStatus, { count: number; amountCents: number }>();
  const currencyWeight = new Map<string, number>();

  for (const row of rows) {
    const collected = toNumber(row.collected_cents);
    const outstanding = toNumber(row.outstanding_cents);
    const issued = toNumber(row.issued_cents);
    const count = toNumber(row.issued_count);

    collectedCents += collected;
    outstandingCents += outstanding;
    issuedCents += issued;

    if (count > 0) {
      const entry = byStatus.get(row.status) ?? { count: 0, amountCents: 0 };
      entry.count += count;
      entry.amountCents += issued;
      byStatus.set(row.status, entry);
    }

    const weight = collected + outstanding + issued;
    if (weight > 0) {
      currencyWeight.set(row.currency, (currencyWeight.get(row.currency) ?? 0) + weight);
    }
  }

  // Largest contributing currency, like getMRR. No FX rates exist in the schema, so a
  // mixed-currency org gets a flag rather than a silently wrong sum.
  const currencies = [...currencyWeight.entries()].sort((a, b) => b[1] - a[1]);

  return {
    organizationId,
    period: resolved,
    currency: currencies[0]?.[0] ?? DEFAULT_CURRENCY,
    isMixedCurrency: currencies.length > 1,
    collectedCents,
    outstandingCents,
    issuedCents,
    byStatus: [...byStatus.entries()]
      .map(([status, v]) => ({ status, count: v.count, amountCents: v.amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
  };
}
