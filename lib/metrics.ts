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
  /** Subscriptions live as of `period.start` — the churn DENOMINATOR. */
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
  /** Number of subscriptions in the opening cohort. */
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
   * (1.12 = 112% NRR). `null` when `startingMRRCents` is 0 — undefined, not 0.
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
  /** Month-end MRR in cents (last snapshot of the month). */
  readonly mrrCents: number;
  /** Month-end active subscription count (last snapshot of the month). */
  readonly activeSubs: number;
  /** Flow metrics: summed across every snapshot in the month. */
  readonly newSubs: number;
  readonly churnedSubs: number;
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

/** Live-as-of predicate for a `Subscription` aliased `s`. Dates, never status. */
function activeAsOf(asOf: Date): Prisma.Sql {
  return Prisma.sql`s."startedAt" <= ${ts(asOf)} AND (s."endedAt" IS NULL OR s."endedAt" > ${ts(asOf)})`;
}

/**
 * Interval normalization for a `Subscription` aliased `s`.
 * MONTHLY contributes its full amount; YEARLY is spread evenly over 12 months and
 * rounded PER ROW (matching prisma/seed.ts, so MRR reconciles with MetricSnapshot).
 * FREE never contributes, whatever amount happens to be stored on the row.
 * `BillingInterval` currently has exactly these two members; a new member would
 * fall through to the monthly branch and must be added here explicitly.
 */
const NORMALIZED_MONTHLY_CENTS_S: Prisma.Sql = Prisma.sql`
  (CASE
     WHEN s.tier = 'FREE'::"PlanTier" THEN 0
     WHEN s."interval" = 'YEARLY'::"BillingInterval" THEN ROUND(s."amountCents"::numeric / 12)
     ELSE s."amountCents"::numeric
   END)`;

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
      COALESCE(SUM(${NORMALIZED_MONTHLY_CENTS_S}), 0)::bigint AS mrr_cents,
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
 * Empty cohort or 0 starting MRR (e.g. FREE-tier only) => `nrr: null`.
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
        AND s."startedAt" <= ${startTs}
        AND (s."endedAt" IS NULL OR s."endedAt" > ${startTs})
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
        (CASE
           WHEN c.tier = 'FREE'::"PlanTier" THEN 0
           WHEN c."interval" = 'YEARLY'::"BillingInterval" THEN ROUND(c."amountCents"::numeric / 12)
           ELSE c."amountCents"::numeric
         END) AS start_mrr,
        -- SUM, not "ORDER BY depth DESC LIMIT 1". The @unique link means a chain is a
        -- simple path with contiguous, disjoint segments, so exactly one node is live
        -- at the period end and the sum equals that node. Summing is nonetheless the
        -- right reduction: it is deterministic, it cannot raise "more than one row
        -- returned by a subquery", and if a chain ever did hold two concurrently-live
        -- nodes their combined MRR is the honest ending value. Picking the deepest
        -- node was neither: it silently preferred a longer branch over a paying one.
        COALESCE((
          SELECT SUM(
            CASE
              WHEN ch.tier = 'FREE'::"PlanTier" THEN 0
              WHEN ch."interval" = 'YEARLY'::"BillingInterval" THEN ROUND(ch."amountCents"::numeric / 12)
              ELSE ch."amountCents"::numeric
            END)
          FROM chain ch
          WHERE ch.root_id = c.id
            AND ch."startedAt" <= ${endTs}
            AND (ch."endedAt" IS NULL OR ch."endedAt" > ${endTs})
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
  // NaN must be caught BEFORE the clamp: Math.max(NaN, 0) and Math.min(NaN, 60) are
  // both NaN, so it would otherwise pass straight through. +/-Infinity clamp normally.
  const requested = Number.isNaN(months) ? DEFAULT_TREND_MONTHS : Math.trunc(months);
  const span = Math.min(Math.max(requested, 0), MAX_TREND_MONTHS);
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
 * Most recent invoices for the org, newest first, with their subscription's tier
 * fetched in the same round trip (no per-row lookup).
 *
 * The tenant filter is applied twice on purpose: directly on `Invoice`, and again
 * on the joined `Subscription`. An invoice whose subscription belongs to another
 * org is corrupt data, and it must not leak through the relation.
 *
 * No invoices => `[]`.
 */
export async function getRecentInvoices(
  organizationId: string,
  limit: number = 10,
): Promise<RecentInvoice[]> {
  const take = Math.max(1, Math.min(Math.trunc(limit) || 1, 100));

  return prisma.invoice.findMany({
    where: {
      organizationId,
      subscription: { is: { organizationId } },
    },
    // `id` breaks ties so pagination/ordering is deterministic for same-instant rows.
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    take,
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