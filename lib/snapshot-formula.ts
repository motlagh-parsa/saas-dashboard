// The daily MetricSnapshot formula — the ONE definition of what a snapshot row
// holds, shared by the seed (prisma/seed.ts, which backfills 18 months) and the
// daily cron (app/api/cron/snapshots/route.ts, which writes one new day). Two
// copies of these rules would drift, and the MRR trend chart reads seeded rows
// and cron-written rows side by side.
//
// Pure and dependency-free on purpose: no Prisma client, no `server-only`, no
// `@/` aliases. The seed runs under ts-node outside Next, where `server-only`
// throws on import.
//
// ---------------------------------------------------------------------------
// Conventions (all UTC)
// ---------------------------------------------------------------------------
// A row for day D describes:
//   - STATE at D's midnight: which segments are live (`startedAt <= D` and
//     `endedAt` null or `> D`) — the same predicate lib/metrics.ts uses, so a
//     segment is inactive ON its `endedAt` instant.
//   - EVENTS during D: segments starting or ending in [D, D + 1 day).
// The seed originally compared event instants to midnight exactly; every seeded
// segment starts and ends on a UTC midnight, so the half-open day range gives
// identical results on seeded data and also counts real mid-day events.
import type { BillingInterval, PlanTier } from "@prisma/client";

export const DAY_MS = 86_400_000;

/** Per-tier seat band (base active users). Grows over the life of a segment. */
const SEATS: Record<PlanTier, number> = {
  FREE: 3,
  STARTER: 12,
  PRO: 45,
  ENTERPRISE: 180,
};

/** One subscription segment, as far as the snapshot formula needs it. */
export interface SnapshotSegment {
  readonly id: string;
  readonly tier: PlanTier;
  readonly interval: BillingInterval;
  readonly amountCents: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/** The six measured columns of a `MetricSnapshot` row. */
export interface SnapshotMetrics {
  readonly mrrCents: number;
  readonly activeSubs: number;
  readonly newSubs: number;
  readonly churnedSubs: number;
  readonly activeUsers: number;
  readonly newUsers: number;
}

/** Monthly-normalized amount used for MRR: FREE is 0, YEARLY is spread over 12 months. */
export function normalizedMonthlyCents(
  tier: PlanTier,
  interval: BillingInterval,
  amountCents: number,
): number {
  if (tier === "FREE") return 0;
  return interval === "YEARLY" ? Math.round(amountCents / 12) : amountCents;
}

/** UTC midnight of the day containing `instant`. */
export function utcDayStart(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/** Stable, deterministic string hash (djb2 xor). No RNG anywhere. */
function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Deterministic seat count for a segment on a given day (monotonic in day).
 *
 * SYNTHETIC: the schema records no real seat or login data, so "active users"
 * is a per-tier seat band that ramps over the segment's first year, plus a
 * small stable per-segment offset. It is consistent, not measured.
 */
function seatCount(segment: SnapshotSegment, orgSlug: string, day: Date): number {
  const base = SEATS[segment.tier];
  const daysActive = Math.max(
    0,
    Math.floor((day.getTime() - segment.startedAt.getTime()) / DAY_MS),
  );
  const ramp = Math.min(1, daysActive / 365); // ramps to full over ~1 year
  const growth = Math.floor(base * 0.6 * ramp); // up to +60% seats over the year
  const offset = hashString(`${orgSlug}:${segment.tier}:${segment.startedAt.toISOString()}`) % 4;
  return base + growth + offset;
}

function isLiveAt(segment: SnapshotSegment, instantMs: number): boolean {
  return (
    segment.startedAt.getTime() <= instantMs &&
    (segment.endedAt === null || segment.endedAt.getTime() > instantMs)
  );
}

function isWithinDay(instant: Date, dayStartMs: number): boolean {
  const ms = instant.getTime();
  return ms >= dayStartMs && ms < dayStartMs + DAY_MS;
}

function activeUsersOn(orgSlug: string, segments: readonly SnapshotSegment[], day: Date): number {
  const dayMs = day.getTime();
  let total = 0;
  for (const segment of segments) {
    if (isLiveAt(segment, dayMs)) total += seatCount(segment, orgSlug, day);
  }
  return total;
}

/**
 * One organization's snapshot for UTC day `day` (must be a UTC midnight).
 *
 * `segments` must include every segment of the org that is live at `day` or the
 * day before, or starts or ends during `day` — passing the org's full history is
 * always correct.
 */
export function computeDaySnapshot(
  orgSlug: string,
  segments: readonly SnapshotSegment[],
  day: Date,
): SnapshotMetrics {
  const dayMs = day.getTime();
  const prevMs = dayMs - DAY_MS;

  const live = segments.filter((segment) => isLiveAt(segment, dayMs));

  let mrrCents = 0;
  for (const segment of live) {
    mrrCents += normalizedMonthlyCents(segment.tier, segment.interval, segment.amountCents);
  }
  const activeUsers = activeUsersOn(orgSlug, segments, day);

  // New PAID customers: a paid segment starts during the day AND the org had no
  // live paid segment the day before (excludes paid->paid plan changes, which
  // are continuations of one customer).
  const paidStarts = segments.filter(
    (segment) => segment.tier !== "FREE" && isWithinDay(segment.startedAt, dayMs),
  ).length;
  const hadLivePaidBefore = segments.some(
    (segment) => segment.tier !== "FREE" && isLiveAt(segment, prevMs),
  );
  const newSubs = paidStarts > 0 && !hadLivePaidBefore ? paidStarts : 0;

  // Churn: a segment ends during the day with NO segment of the org starting the
  // same day (a same-day start is a plan-change hand-off, not a departure).
  const churnedSubs = segments.filter(
    (segment) =>
      segment.endedAt !== null &&
      isWithinDay(segment.endedAt, dayMs) &&
      !segments.some(
        (other) => other.id !== segment.id && isWithinDay(other.startedAt, dayMs),
      ),
  ).length;

  // Net seats added since the day before, floored at 0.
  const newUsers = Math.max(
    0,
    activeUsers - activeUsersOn(orgSlug, segments, new Date(prevMs)),
  );

  return {
    mrrCents,
    activeSubs: live.length,
    newSubs,
    churnedSubs,
    activeUsers,
    newUsers,
  };
}
