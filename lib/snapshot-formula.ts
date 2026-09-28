// The daily MetricSnapshot formula — the ONE definition of what a snapshot row
// holds, shared by the sample-data generator (lib/sample-data.ts, which backfills
// 18 months), the daily cron (app/api/cron/snapshots/route.ts) and
// scripts/verify-metrics.ts. Two copies of these rules would drift, and the MRR
// trend chart reads rows written by all of them side by side.
//
// Pure and dependency-free on purpose: no Prisma client, no `server-only`, no
// `@/` aliases — type imports only.
//
// ---------------------------------------------------------------------------
// Definitions (all instants UTC; "day D" means D's midnight)
// ---------------------------------------------------------------------------
//   Monthly MRR of a segment = amountCents × quantity ÷ months in its interval,
//     where months = intervalCount for MONTH and 12 × intervalCount for YEAR.
//     Summed EXACTLY (integer arithmetic over a common denominator) and rounded
//     ONCE, half up, at the end of the sum — never per row.
//   Live at t:     startedAt <= t AND (endedAt IS NULL OR endedAt > t).
//   Active customer at t: at least one live segment with MRR > 0.
//   A row for day D holds the STATE at D and the FLOWS in (D − 1 day, D]:
//     newCustomers     — active at D, not at D − 1, and never active before.
//     churnedCustomers — active at D − 1, not at D.
//     newSubs          — segments starting in (D − 1, D].
//     churnedSubs      — segments ending in (D − 1, D] by a real cancellation
//                        (`canceledAt` set). A plan change ends a segment without
//                        one, so it is not churn.
//   A customer who returns after being inactive is neither new nor churned on
//   the day they return — they are a REACTIVATION, which the revenue bridge
//   (lib/metrics.ts) reports as its own movement.
import type { BillingInterval } from "@prisma/client";

export const DAY_MS = 86_400_000;

/** One subscription segment, as far as the formula needs it. */
export interface SnapshotSegment {
  readonly id: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly quantity: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly canceledAt: Date | null;
}

/** The measured columns of a `MetricSnapshot` row. */
export interface SnapshotMetrics {
  readonly mrrCents: number;
  readonly activeSubs: number;
  readonly newSubs: number;
  readonly churnedSubs: number;
  readonly activeCustomers: number;
  readonly newCustomers: number;
  readonly churnedCustomers: number;
}

type PriceTerms = Pick<SnapshotSegment, "amountCents" | "quantity" | "interval" | "intervalCount">;

/** Months one billing interval spans: MONTH×3 is 3, YEAR×1 is 12. */
export function monthsInInterval(interval: BillingInterval, intervalCount: number): number {
  return interval === "YEAR" ? 12 * intervalCount : intervalCount;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Monthly-normalized MRR of a set of segments, in cents: the exact sum of
 * `amount × quantity ÷ months`, rounded ONCE, half up.
 *
 * Exact because every term is put over the least common multiple of the
 * interval lengths and added as an integer — floating-point division per row
 * would put errors in the last place of each term, and those can tip a total
 * that sits exactly on a half-cent the wrong way.
 */
export function roundedMonthlyCents(segments: readonly PriceTerms[]): number {
  let denominator = 1;
  for (const segment of segments) {
    const months = monthsInInterval(segment.interval, segment.intervalCount);
    denominator = (denominator / gcd(denominator, months)) * months;
  }
  let numerator = 0;
  for (const segment of segments) {
    const months = monthsInInterval(segment.interval, segment.intervalCount);
    numerator += segment.amountCents * segment.quantity * (denominator / months);
  }
  // Half up for a non-negative numerator (amounts are CHECK-constrained >= 0).
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** UTC midnight of the day containing `instant`. */
export function utcDayStart(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

export function isLiveAt(segment: SnapshotSegment, instantMs: number): boolean {
  return (
    segment.startedAt.getTime() <= instantMs &&
    (segment.endedAt === null || segment.endedAt.getTime() > instantMs)
  );
}

/** A segment that bills something and lasts a non-zero span. */
function isPaying(segment: SnapshotSegment): boolean {
  return (
    segment.amountCents * segment.quantity > 0 &&
    (segment.endedAt === null || segment.endedAt.getTime() > segment.startedAt.getTime())
  );
}

/** Customer ids with at least one live paying segment at `instantMs`. */
export function activeCustomerIds(
  segments: readonly SnapshotSegment[],
  instantMs: number,
): Set<string> {
  const active = new Set<string>();
  for (const segment of segments) {
    if (isPaying(segment) && isLiveAt(segment, instantMs)) active.add(segment.customerId);
  }
  return active;
}

/** The first instant each customer was ever active (their earliest paying start). */
export function firstActiveAt(segments: readonly SnapshotSegment[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const segment of segments) {
    if (!isPaying(segment)) continue;
    const start = segment.startedAt.getTime();
    const known = first.get(segment.customerId);
    if (known === undefined || start < known) first.set(segment.customerId, start);
  }
  return first;
}

function endsWithin(instant: Date | null, fromExclusiveMs: number, toInclusiveMs: number): boolean {
  if (instant === null) return false;
  const ms = instant.getTime();
  return ms > fromExclusiveMs && ms <= toInclusiveMs;
}

/**
 * One organization's snapshot for UTC day `day` (must be a UTC midnight).
 *
 * `segments` must be the organization's FULL subscription history: "new"
 * means never active before, which only the whole history can answer. Pass
 * `firstActive` (from `firstActiveAt(segments)`) when computing many days in a
 * row to avoid recomputing it per day; it is derived when omitted.
 */
export function computeDaySnapshot(
  segments: readonly SnapshotSegment[],
  day: Date,
  firstActive: ReadonlyMap<string, number> = firstActiveAt(segments),
): SnapshotMetrics {
  const dayMs = day.getTime();
  const prevMs = dayMs - DAY_MS;

  const live = segments.filter((segment) => isLiveAt(segment, dayMs));
  const activeNow = activeCustomerIds(segments, dayMs);
  const activeBefore = activeCustomerIds(segments, prevMs);

  let newCustomers = 0;
  for (const customerId of activeNow) {
    if (activeBefore.has(customerId)) continue;
    const first = firstActive.get(customerId);
    // Never active at or before D − 1: their first paying instant is after it.
    if (first !== undefined && first > prevMs) newCustomers += 1;
  }

  let churnedCustomers = 0;
  for (const customerId of activeBefore) {
    if (!activeNow.has(customerId)) churnedCustomers += 1;
  }

  return {
    mrrCents: roundedMonthlyCents(live),
    activeSubs: live.length,
    newSubs: segments.filter((segment) => endsWithin(segment.startedAt, prevMs, dayMs)).length,
    churnedSubs: segments.filter(
      (segment) => segment.canceledAt !== null && endsWithin(segment.endedAt, prevMs, dayMs),
    ).length,
    activeCustomers: activeNow.size,
    newCustomers,
    churnedCustomers,
  };
}
