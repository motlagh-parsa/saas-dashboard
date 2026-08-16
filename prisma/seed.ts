/**
 * SaaS Metrics Dashboard — deterministic seed.
 *
 * Design goals (see prisma/schema.prisma for the source of truth):
 *   - Money is INTEGER MINOR UNITS (cents). Never Float/Decimal.
 *   - Subscriptions are modeled as a chain of lifecycle SEGMENTS per org:
 *       * plan change (upgrade/downgrade) = end the current segment (endedAt = change
 *         date, canceledAt = null) and open a NEW segment starting the same day, with
 *         previousSubscriptionId pointing back at the segment it supersedes.
 *       * churn                            = end the segment with NO same-day
 *         replacement (endedAt = canceledAt = churn date, status CANCELED). Nothing
 *         ever links back to a cancelled segment, so a later reactivation starts a
 *         fresh chain (see Hooli: churn -> 6-month gap -> reactivation).
 *     The previousSubscriptionId link is what lets lib/metrics.ts follow a customer
 *     across plan changes when computing NRR. It is `@unique`, so the hand-off graph
 *     is a forest of simple paths and the chain walk cannot fan out or fan in.
 *   - Invoices are generated per billing period per segment from the segment amount.
 *   - MetricSnapshot rows are COMPUTED from the Subscription rows we actually wrote
 *     (re-queried from the database), never randomized — so a reviewer who sums
 *     invoices or counts active subs gets numbers that reconcile.
 *
 * Metric definitions implemented here (also enforced by the schema comment that ARR
 * and churn-rate are derived at READ time and therefore NOT stored):
 *   - mrrCents     = sum over subscriptions active that day of the monthly-normalized
 *                    amount (MONTHLY -> amountCents, YEARLY -> round(amountCents/12)).
 *   - activeSubs   = subscriptions active that day, by DATE lifecycle:
 *                    startedAt <= day AND (endedAt IS NULL OR endedAt > day).
 *                    (A segment is inactive ON its endedAt day; status is the final
 *                    state and is intentionally NOT used for per-day activity.)
 *   - newSubs      = starts of a PAID segment (tier != FREE) on a day where the org
 *                    had NO active paid subscription the PREVIOUS day. This counts
 *                    genuinely new / reactivated paying customers and free-trial ->
 *                    paid conversions, but EXCLUDES paid->paid plan changes
 *                    (upgrades/downgrades), which are continuations of one customer.
 *   - churnedSubs  = segments whose endedAt is that day AND the org has NO segment
 *                    starting the same day (true cancellation, not a plan-change
 *                    hand-off). Total across all snapshots is asserted > 0.
 *   - activeUsers  = seat count summed over active subscriptions; per-tier seat band
 *                    that ramps up deterministically over the life of the segment.
 *   - newUsers     = max(0, activeUsers(day) - activeUsers(day - 1)); net seats added.
 *
 * Determinism: no Math.random() is used. Any per-segment "jitter" is a pure function
 * of stable inputs (org slug + tier + start date), so re-running produces identical
 * numbers. The run first clears seed-owned tables in FK-safe order, so it is idempotent.
 *
 * The ONE moving input is the anchor date: the 18-month window ends on the day the
 * seed runs, so the dashboard's short presets always land on real data. Everything
 * else derives from it. Pin it with SEED_ANCHOR_DATE=YYYY-MM-DD for reproducible runs.
 */

// Prisma 7: the client resolves from "@prisma/client" (classic prisma-client-js
// generator, default output). PrismaClient is the only RUNTIME value we need here;
// the enums are imported as TYPES only, and every call site uses a plain string
// literal checked against the enum type via typed constants/records. This keeps the
// seed independent of whether the generator re-exports enum values at runtime.
import { PrismaClient } from "@prisma/client";
import type {
  Prisma,
  PlanTier,
  BillingInterval,
  SubscriptionStatus,
  InvoiceStatus,
  Role,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Window: 18 months of daily history ending on the anchor day (inclusive).
//
// The window is ANCHORED TO THE CURRENT DATE rather than hardcoded. A fixed window
// goes stale: once "now" drifts past its end, `last_7_days` / `month_to_date` /
// `last_30_days` all resolve to ranges with no data in them and the dashboard renders
// flat MRR and 0% churn.
//
// The anchor is the ONLY moving input in this file. Everything else is a pure
// function of it plus stable strings, so a re-run on the same day reproduces
// byte-identical output. Set SEED_ANCHOR_DATE=YYYY-MM-DD to pin it.
//
// All dates are UTC midnights; time-zone conversion is a presentation concern.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function addMonthsUTC(base: Date, months: number): Date {
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, base.getUTCDate()),
  );
}

function addDaysUTC(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

/** Calendar months of history generated before the anchor month. */
const HISTORY_MONTHS = 17;

function resolveAnchor(): Date {
  const override = process.env.SEED_ANCHOR_DATE;
  const base = override === undefined ? new Date() : new Date(`${override}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`SEED_ANCHOR_DATE must be YYYY-MM-DD; got "${override}".`);
  }
  // Clamp day-of-month to 28 so the month arithmetic above can never roll over:
  // addMonthsUTC does NOT clamp, so an anchor on the 31st would make
  // `Date.UTC(y, m + 1, 31)` spill into the following month and desynchronise the
  // segment offsets from the snapshot grid.
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(base.getUTCDate(), 28)),
  );
}

/** "Today" at UTC midnight. Segment lifecycle offset `HISTORY_MONTHS` lands here. */
const ANCHOR = resolveAnchor();

/** Lifecycle offset 0 — `HISTORY_MONTHS` before the anchor, same day-of-month. */
const WINDOW_START = addMonthsUTC(ANCHOR, -HISTORY_MONTHS);
/** Exclusive. Daily snapshots run up to AND INCLUDING the anchor day. */
const WINDOW_END_EXCLUSIVE = addDaysUTC(ANCHOR, 1);
const CURRENT_MONTH_START = new Date(
  Date.UTC(ANCHOR.getUTCFullYear(), ANCHOR.getUTCMonth(), 1),
);
const PREV_MONTH_START = addMonthsUTC(CURRENT_MONTH_START, -1);

// ---------------------------------------------------------------------------
// Pricing — consistent per (tier, interval), in integer cents.
// YEARLY amounts are chosen divisible by 12 so the monthly-normalized MRR is exact.
// ---------------------------------------------------------------------------

const MONTHLY_CENTS: Record<PlanTier, number> = {
  FREE: 0,
  STARTER: 4_900, // $49 / mo
  PRO: 19_900, // $199 / mo
  ENTERPRISE: 99_900, // $999 / mo
};

const YEARLY_CENTS: Record<PlanTier, number> = {
  FREE: 0,
  STARTER: 52_800, // $528 / yr  -> $44 / mo
  PRO: 214_800, // $2,148 / yr -> $179 / mo
  ENTERPRISE: 1_078_800, // $10,788 / yr -> $899 / mo
};

// Per-tier seat band (base active users). Grows over the life of a segment.
const SEATS: Record<PlanTier, number> = {
  FREE: 3,
  STARTER: 12,
  PRO: 45,
  ENTERPRISE: 180,
};

function amountForCents(tier: PlanTier, interval: BillingInterval): number {
  return interval === "YEARLY" ? YEARLY_CENTS[tier] : MONTHLY_CENTS[tier];
}

/** Monthly-normalized amount used for MRR (YEARLY spread across 12 months). */
function normalizedMonthlyCents(
  tier: PlanTier,
  interval: BillingInterval,
  amountCents: number,
): number {
  if (tier === "FREE") return 0;
  return interval === "YEARLY" ? Math.round(amountCents / 12) : amountCents;
}

// ---------------------------------------------------------------------------
// Date helpers (all UTC). addMonthsUTC / addDaysUTC are defined above the window
// block because the anchor constants depend on them.
// ---------------------------------------------------------------------------

/** Lifecycle date `offset` months after the window start (same day-of-month). */
function monthOffsetDate(offset: number): Date {
  return addMonthsUTC(WINDOW_START, offset);
}

function eachDayUTC(startInclusive: Date, endExclusive: Date): Date[] {
  const days: Date[] = [];
  for (let t = startInclusive.getTime(); t < endExclusive.getTime(); t += DAY_MS) {
    days.push(new Date(t));
  }
  return days;
}

/** Stable, deterministic string hash (djb2 xor). No RNG anywhere. */
function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Org lifecycle specs. Offsets are months from WINDOW_START (0 = Jan 2025).
// endReason: PLAN_CHANGE => a new segment starts the same day (continuation);
//            CHURN       => the customer leaves, no same-day replacement.
// ---------------------------------------------------------------------------

interface SegmentSpec {
  tier: PlanTier;
  interval: BillingInterval;
  startOffset: number;
  endOffset: number | null; // null = still active at window end
  endReason: "PLAN_CHANGE" | "CHURN" | null; // null iff endOffset is null
}

interface OrgSpec {
  name: string;
  slug: string;
  /** Status stamped on the trailing (still-active) segment. Defaults to ACTIVE. */
  activeStatus?: SubscriptionStatus;
  segments: SegmentSpec[];
}

const M: BillingInterval = "MONTHLY";
const Y: BillingInterval = "YEARLY";

export const ORG_SPECS: OrgSpec[] = [
  {
    // Steady grower: two upgrades, still active.
    name: "Northwind Analytics",
    slug: "northwind-analytics",
    segments: [
      { tier: "STARTER", interval: M, startOffset: 0, endOffset: 6, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: M, startOffset: 6, endOffset: 14, endReason: "PLAN_CHANGE" },
      { tier: "ENTERPRISE", interval: M, startOffset: 14, endOffset: null, endReason: null },
    ],
  },
  {
    // Free trial -> paid conversion -> upgrade, still active.
    name: "Acme Corp",
    slug: "acme-corp",
    segments: [
      { tier: "FREE", interval: M, startOffset: 0, endOffset: 1, endReason: "PLAN_CHANGE" },
      { tier: "STARTER", interval: M, startOffset: 1, endOffset: 9, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: M, startOffset: 9, endOffset: null, endReason: null },
    ],
  },
  {
    // Upgrade then DOWNGRADE, still active.
    name: "Globex Media",
    slug: "globex-media",
    segments: [
      { tier: "STARTER", interval: M, startOffset: 0, endOffset: 5, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: M, startOffset: 5, endOffset: 12, endReason: "PLAN_CHANGE" },
      { tier: "STARTER", interval: M, startOffset: 12, endOffset: null, endReason: null }, // downgrade
    ],
  },
  {
    // Grows then fully CHURNS (never returns).
    name: "Initech",
    slug: "initech",
    segments: [
      { tier: "STARTER", interval: M, startOffset: 0, endOffset: 4, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: M, startOffset: 4, endOffset: 10, endReason: "CHURN" },
    ],
  },
  {
    // YEARLY billing, downgraded at renewal, still active.
    name: "Umbrella SaaS",
    slug: "umbrella-saas",
    segments: [
      { tier: "ENTERPRISE", interval: Y, startOffset: 0, endOffset: 11, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: Y, startOffset: 11, endOffset: null, endReason: null }, // downgrade
    ],
  },
  {
    // Churn -> gap -> reactivation -> churn again. Two churn events, one reactivation.
    name: "Hooli",
    slug: "hooli",
    segments: [
      { tier: "STARTER", interval: M, startOffset: 0, endOffset: 7, endReason: "CHURN" },
      { tier: "PRO", interval: M, startOffset: 13, endOffset: 17, endReason: "CHURN" },
    ],
  },
  {
    // Long-lived enterprise; currently PAST_DUE (recent invoices unpaid).
    name: "Stark Industries",
    slug: "stark-industries",
    activeStatus: "PAST_DUE",
    segments: [
      { tier: "ENTERPRISE", interval: M, startOffset: 0, endOffset: null, endReason: null },
    ],
  },
  {
    // Acquired mid-window (month 3), then upgraded, still active.
    name: "Wayne Enterprises",
    slug: "wayne-enterprises",
    segments: [
      { tier: "STARTER", interval: M, startOffset: 3, endOffset: 8, endReason: "PLAN_CHANGE" },
      { tier: "PRO", interval: M, startOffset: 8, endOffset: null, endReason: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Pure lifecycle -> concrete segments (no DB access). main() persists these;
// the metric verification exercises the identical output in memory, so DB rows
// and computed snapshots are guaranteed to reconcile.
// ---------------------------------------------------------------------------

interface BuiltSegment {
  syntheticId: string; // stable id for in-memory reconciliation; DB uses real cuids
  /**
   * Synthetic id of the segment this one CONTINUES, or null if it starts a fresh
   * lifecycle. Resolved to a real cuid and written to
   * `Subscription.previousSubscriptionId` in main().
   */
  previousSyntheticId: string | null;
  tier: PlanTier;
  interval: BillingInterval;
  amountCents: number;
  startedAt: Date;
  endedAt: Date | null;
  canceledAt: Date | null;
  status: SubscriptionStatus;
  isChurn: boolean;
}

export function buildSegments(spec: OrgSpec): BuiltSegment[] {
  return spec.segments.map((seg, index) => {
    const startedAt = monthOffsetDate(seg.startOffset);
    const endedAt = seg.endOffset === null ? null : monthOffsetDate(seg.endOffset);
    const isChurn = seg.endReason === "CHURN";
    const status: SubscriptionStatus =
      endedAt === null ? spec.activeStatus ?? "ACTIVE" : "CANCELED";
    // canceledAt is set ONLY for a true customer cancellation (churn), never for a
    // plan-change hand-off. Mirrors the churn definition and the canceledAt index.
    const canceledAt = isChurn ? endedAt : null;

    // The hand-off link. A segment continues the previous one ONLY when that one
    // ended in a PLAN_CHANGE. After a CHURN the link stays null — that is what keeps
    // Hooli's churn -> 6-month gap -> reactivation scored as churn instead of letting
    // the NRR chain walk hop the gap and call the customer retained.
    const predecessor = index > 0 ? spec.segments[index - 1] : null;
    const previousSyntheticId =
      predecessor !== null && predecessor.endReason === "PLAN_CHANGE"
        ? `${spec.slug}#${index - 1}`
        : null;

    return {
      syntheticId: `${spec.slug}#${index}`,
      previousSyntheticId,
      tier: seg.tier,
      interval: seg.interval,
      amountCents: amountForCents(seg.tier, seg.interval),
      startedAt,
      endedAt,
      canceledAt,
      status,
      isChurn,
    };
  });
}

// ---------------------------------------------------------------------------
// Snapshot computation — reads the Subscription rows re-queried from the DB.
// ---------------------------------------------------------------------------

export interface SubForCalc {
  id: string;
  tier: PlanTier;
  interval: BillingInterval;
  amountCents: number;
  startedAt: Date;
  endedAt: Date | null;
}

/** Deterministic seat count for a subscription on a given day (monotonic in day). */
function seatCount(sub: SubForCalc, orgSlug: string, day: Date): number {
  const base = SEATS[sub.tier];
  const daysActive = Math.max(0, Math.floor((day.getTime() - sub.startedAt.getTime()) / DAY_MS));
  const ramp = Math.min(1, daysActive / 365); // ramps to full over ~1 year
  const growth = Math.floor(base * 0.6 * ramp); // up to +60% seats over the year
  // Small constant per-segment offset derived ONLY from stable inputs (deterministic).
  const offset = hashString(`${orgSlug}:${sub.tier}:${sub.startedAt.toISOString()}`) % 4;
  return base + growth + offset;
}

export function computeSnapshots(
  organizationId: string,
  orgSlug: string,
  subs: SubForCalc[],
): Prisma.MetricSnapshotCreateManyInput[] {
  const rows: Prisma.MetricSnapshotCreateManyInput[] = [];
  let prevActiveUsers = 0;

  for (const day of eachDayUTC(WINDOW_START, WINDOW_END_EXCLUSIVE)) {
    const dayMs = day.getTime();
    const prevMs = dayMs - DAY_MS;

    const activeToday = subs.filter(
      (s) => s.startedAt.getTime() <= dayMs && (s.endedAt === null || s.endedAt.getTime() > dayMs),
    );

    let mrrCents = 0;
    let activeUsers = 0;
    for (const s of activeToday) {
      mrrCents += normalizedMonthlyCents(s.tier, s.interval, s.amountCents);
      activeUsers += seatCount(s, orgSlug, day);
    }

    // New PAID customers today: a paid segment starts today AND the org had no
    // active paid subscription yesterday (excludes paid->paid plan changes).
    const paidStartsToday = subs.filter(
      (s) => s.tier !== "FREE" && s.startedAt.getTime() === dayMs,
    ).length;
    const hadActivePaidYesterday = subs.some(
      (s) =>
        s.tier !== "FREE" &&
        s.startedAt.getTime() <= prevMs &&
        (s.endedAt === null || s.endedAt.getTime() > prevMs),
    );
    const newSubs = paidStartsToday > 0 && !hadActivePaidYesterday ? paidStartsToday : 0;

    // Churn today: a segment ends today with NO same-day replacement for this org.
    const churnedSubs = subs.filter(
      (s) =>
        s.endedAt !== null &&
        s.endedAt.getTime() === dayMs &&
        !subs.some((x) => x.id !== s.id && x.startedAt.getTime() === dayMs),
    ).length;

    const newUsers = Math.max(0, activeUsers - prevActiveUsers);

    rows.push({
      organizationId,
      date: day,
      mrrCents,
      activeSubs: activeToday.length,
      newSubs,
      churnedSubs,
      activeUsers,
      newUsers,
    });

    prevActiveUsers = activeUsers;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Seed run.
// ---------------------------------------------------------------------------

async function clearSeedData(): Promise<void> {
  // FK-safe order: children before parents. Wrapped so a re-run is all-or-nothing.
  await prisma.$transaction([
    prisma.metricSnapshot.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.organization.deleteMany(),
  ]);
}

async function main(): Promise<void> {
  await clearSeedData();

  // Demo user so login + tenant switching works. Upsert keeps auth rows stable.
  const demoUser = await prisma.user.upsert({
    where: { email: "demo@saas-dashboard.dev" },
    update: { name: "Demo Operator" },
    create: { email: "demo@saas-dashboard.dev", name: "Demo Operator" },
  });

  const invoiceRows: Prisma.InvoiceCreateManyInput[] = [];
  let churnEventCount = 0;

  for (let orgIndex = 0; orgIndex < ORG_SPECS.length; orgIndex++) {
    const spec = ORG_SPECS[orgIndex];

    const org = await prisma.organization.create({
      data: { name: spec.name, slug: spec.slug },
      select: { id: true },
    });

    // Demo user owns the first org and is a member of the rest (tenant switching).
    const role: Role = orgIndex === 0 ? "OWNER" : "MEMBER";
    await prisma.membership.create({
      data: {
        userId: demoUser.id,
        organizationId: org.id,
        role,
      },
    });

    // Segments are built in lifecycle order, so a predecessor always exists in this
    // map by the time its successor is written.
    const subscriptionIdBySynthetic = new Map<string, string>();

    for (const built of buildSegments(spec)) {
      if (built.isChurn) churnEventCount++;

      const previousSubscriptionId =
        built.previousSyntheticId === null
          ? null
          : subscriptionIdBySynthetic.get(built.previousSyntheticId) ?? null;

      if (built.previousSyntheticId !== null && previousSubscriptionId === null) {
        throw new Error(
          `Hand-off target ${built.previousSyntheticId} was not written before ${built.syntheticId}.`,
        );
      }

      const sub = await prisma.subscription.create({
        data: {
          organizationId: org.id,
          tier: built.tier,
          status: built.status,
          amountCents: built.amountCents,
          currency: "USD",
          interval: built.interval,
          startedAt: built.startedAt,
          canceledAt: built.canceledAt,
          endedAt: built.endedAt,
          previousSubscriptionId,
        },
        select: { id: true },
      });
      subscriptionIdBySynthetic.set(built.syntheticId, sub.id);

      // One invoice per billing period the segment was active. FREE => no invoice.
      if (built.amountCents > 0) {
        const periodMonths = built.interval === "YEARLY" ? 12 : 1;
        const effectiveEnd = built.endedAt ?? WINDOW_END_EXCLUSIVE;
        for (
          let cursor = built.startedAt;
          cursor.getTime() < effectiveEnd.getTime();
          cursor = addMonthsUTC(cursor, periodMonths)
        ) {
          const issuedAt = cursor;
          let invoiceStatus: InvoiceStatus = "PAID";
          let paidAt: Date | null = addDaysUTC(issuedAt, 2);

          if (issuedAt.getTime() >= CURRENT_MONTH_START.getTime()) {
            // Current, in-progress billing period: issued but not yet paid.
            invoiceStatus = "OPEN";
            paidAt = null;
          } else if (
            spec.slug === "stark-industries" &&
            issuedAt.getTime() >= PREV_MONTH_START.getTime()
          ) {
            // Past-due account: the prior period's invoice is still OPEN (unpaid and
            // overdue). PAST_DUE lives on the Subscription (see spec.activeStatus);
            // InvoiceStatus has no PAST_DUE, so an overdue invoice stays OPEN.
            invoiceStatus = "OPEN";
            paidAt = null;
          }

          invoiceRows.push({
            organizationId: org.id,
            subscriptionId: sub.id,
            amountCents: built.amountCents,
            currency: "USD",
            status: invoiceStatus,
            issuedAt,
            paidAt,
          });
        }
      }
    }
  }

  await prisma.invoice.createMany({ data: invoiceRows });

  // Daily snapshots, computed from the Subscription rows we just wrote.
  let snapshotCount = 0;
  const organizations = await prisma.organization.findMany({
    select: { id: true, slug: true },
    orderBy: { createdAt: "asc" },
  });

  for (const org of organizations) {
    const subs = await prisma.subscription.findMany({
      where: { organizationId: org.id },
      select: { id: true, tier: true, interval: true, amountCents: true, startedAt: true, endedAt: true },
      orderBy: { startedAt: "asc" },
    });
    const snapshots = computeSnapshots(org.id, org.slug, subs);
    await prisma.metricSnapshot.createMany({ data: snapshots });
    snapshotCount += snapshots.length;
  }

  // ---- Summary + churn invariant ----------------------------------------
  const [orgCount, subCount, invoiceCount] = await Promise.all([
    prisma.organization.count(),
    prisma.subscription.count(),
    prisma.invoice.count(),
  ]);
  const churnAgg = await prisma.metricSnapshot.aggregate({ _sum: { churnedSubs: true } });
  const totalChurnedSubs = churnAgg._sum.churnedSubs ?? 0;

  // ---- Hand-off link invariants -----------------------------------------
  // These are what the NRR chain walk in lib/metrics.ts depends on.
  const expectedHandoffs = ORG_SPECS.reduce(
    (total, spec) =>
      total + buildSegments(spec).filter((s) => s.previousSyntheticId !== null).length,
    0,
  );
  const actualHandoffs = await prisma.subscription.count({
    where: { previousSubscriptionId: { not: null } },
  });
  if (actualHandoffs !== expectedHandoffs) {
    throw new Error(
      `Invariant violated: expected ${expectedHandoffs} hand-off links, found ${actualHandoffs}.`,
    );
  }

  // A cancelled segment must never be superseded — that is the churn/plan-change
  // distinction the whole NRR calculation rests on.
  const cancelledWithSuccessor = await prisma.subscription.count({
    where: { canceledAt: { not: null }, next: { isNot: null } },
  });
  if (cancelledWithSuccessor !== 0) {
    throw new Error(
      `Invariant violated: ${cancelledWithSuccessor} cancelled segment(s) have a successor.`,
    );
  }

  // A hand-off must never cross a tenant boundary. Prisma's filter language cannot
  // compare a column against a column on the related row, so this is raw — with the
  // comparison done entirely in SQL, no user input, no interpolation.
  const [{ count: crossOrgLinks }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count
    FROM "Subscription" s
    JOIN "Subscription" p ON p.id = s."previousSubscriptionId"
    WHERE p."organizationId" <> s."organizationId"
  `;
  if (Number(crossOrgLinks) !== 0) {
    throw new Error(
      `Invariant violated: ${crossOrgLinks} hand-off link(s) cross an organization boundary.`,
    );
  }

  // Latest-day headline numbers so the run visibly makes sense.
  const latest = await prisma.metricSnapshot.aggregate({
    where: { date: new Date(WINDOW_END_EXCLUSIVE.getTime() - DAY_MS) },
    _sum: { mrrCents: true, activeSubs: true, activeUsers: true },
  });
  const paidInvoiceAgg = await prisma.invoice.aggregate({
    where: { status: "PAID" },
    _sum: { amountCents: true },
  });

  const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

  console.log("Seed complete.");
  console.log(`  anchor        : ${isoDay(ANCHOR)}${process.env.SEED_ANCHOR_DATE ? " (pinned via SEED_ANCHOR_DATE)" : " (today, UTC)"}`);
  console.log(`  window        : ${isoDay(WINDOW_START)} .. ${isoDay(ANCHOR)} inclusive`);
  console.log(`  organizations : ${orgCount}`);
  console.log(`  subscriptions : ${subCount} (segments across all orgs)`);
  console.log(`  hand-off links: ${actualHandoffs} (plan changes; null across churn gaps)`);
  console.log(`  invoices      : ${invoiceCount}`);
  console.log(`  snapshots     : ${snapshotCount}`);
  console.log(`  churn events  : ${totalChurnedSubs} (segment cancellations w/o replacement)`);
  console.log(`  churn-marked  : ${churnEventCount} (segments flagged CHURN in specs)`);
  console.log(
    `  latest day    : MRR $${((latest._sum.mrrCents ?? 0) / 100).toFixed(2)} | ` +
      `activeSubs ${latest._sum.activeSubs ?? 0} | activeUsers ${latest._sum.activeUsers ?? 0}`,
  );
  console.log(
    `  paid invoices : $${((paidInvoiceAgg._sum.amountCents ?? 0) / 100).toFixed(2)} collected total`,
  );

  if (totalChurnedSubs <= 0) {
    throw new Error("Invariant violated: total churnedSubs must be > 0.");
  }
}

// Run only when executed directly (e.g. `prisma db seed`), not when imported by a
// verification/test harness that exercises the pure builders above.
if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
      await pool.end();
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      await pool.end();
      process.exit(1);
    });
}