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
 * Notifications are the one AUTHORED table here: operational events for the demo
 * org, written last, reconciling against nothing. Their timestamps still derive
 * from the same anchor as everything else, so the feed stays inside the last 14
 * days on every run.
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
  NotificationType,
  Role,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// The per-day snapshot formula lives in lib/ so the daily cron
// (app/api/cron/snapshots) writes rows with exactly the same rules. Relative
// import: ts-node does not resolve the app's `@/` alias.
import { computeDaySnapshot, type SnapshotSegment } from "../lib/snapshot-formula";
// The price list is shared with the "Add subscription" form for the same reason.
import { PLAN_PRICE_CENTS } from "../lib/plan-pricing";

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
const HOUR_MS = 3_600_000;

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
// Pricing — consistent per (tier, interval), in integer cents. The table itself
// lives in lib/plan-pricing.ts (YEARLY amounts divisible by 12 there, so the
// monthly-normalized MRR is exact).
// ---------------------------------------------------------------------------

function amountForCents(tier: PlanTier, interval: BillingInterval): number {
  return PLAN_PRICE_CENTS[interval][tier];
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
//
// The per-day rules (live-at-midnight state, paid new customers, churn without a
// same-day hand-off, synthetic seat counts) live in lib/snapshot-formula.ts and
// are shared with the daily cron. This file only walks the window.
// ---------------------------------------------------------------------------

export type SubForCalc = SnapshotSegment;

export function computeSnapshots(
  organizationId: string,
  orgSlug: string,
  subs: SubForCalc[],
): Prisma.MetricSnapshotCreateManyInput[] {
  return eachDayUTC(WINDOW_START, WINDOW_END_EXCLUSIVE).map((day) => ({
    organizationId,
    date: day,
    ...computeDaySnapshot(orgSlug, subs, day),
  }));
}

// ---------------------------------------------------------------------------
// Notification feed (demo org only).
//
// These are OPERATIONAL EVENTS, not derived metrics: unlike MetricSnapshot, they
// are authored rather than computed, so they are written last and nothing else
// reconciles against them. Every amount and plan tier in the copy below is still
// taken from the seeded price list ($49 Starter / $199 Pro / $999 Enterprise /
// $2,148 annual Pro) and the demo org's own MRR, so nothing contradicts a number
// the dashboard can show. The customer names are intentionally NOT other seeded
// organizations: those are separate tenants, and one tenant's feed must never
// look like it is quoting another tenant's ledger.
//
// `userId = null` is an ORG-WIDE notification (everyone in the workspace sees
// it); a set `userId` is personal to the demo user.
//
// Timestamps are relative to ANCHOR (UTC midnight of the seed's anchor day), so
// the feed moves with the rest of the window and stays deterministic under
// SEED_ANCHOR_DATE. Every createdAt lands inside the last 14 days, and every
// readAt is strictly after its own createdAt and never in the future.
// ---------------------------------------------------------------------------

/** "Now" for the feed: the same UTC midnight every other window constant uses. */
const FEED_NOW = ANCHOR;

/** Days of history the notification feed spans. Every spec must fit inside it. */
const FEED_WINDOW_DAYS = 14;

/** Exactly this many specs must be left unread — asserted after the write. */
const EXPECTED_UNREAD = 3;

function addHoursUTC(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * HOUR_MS);
}

interface NotificationSpec {
  type: NotificationType;
  title: string;
  body: string;
  /** true => personal to the demo user; false => org-wide (userId null). */
  personal: boolean;
  /** Hours before FEED_NOW that the event was raised. */
  hoursAgo: number;
  /** null => still unread. Otherwise hours AFTER createdAt that it was read. */
  readAfterHours: number | null;
}

/**
 * Newest first. The three most recent are unread, which matches how an operator
 * actually works down an inbox — and gives the bell a non-zero count without
 * making the whole feed look untouched.
 *
 * All 8 NotificationType values appear; INVOICE_PAID and SYSTEM repeat, because
 * those are genuinely the two highest-volume events in a real feed.
 */
const NOTIFICATION_SPECS: NotificationSpec[] = [
  {
    type: "MRR_MILESTONE",
    title: "MRR milestone reached",
    body: "Recurring revenue crossed $1,000 for the first time after the Enterprise upgrade.",
    personal: false,
    hoursAgo: 2,
    readAfterHours: null,
  },
  {
    type: "INVOICE_OVERDUE",
    title: "Invoice overdue",
    body: "The Enterprise plan invoice for $999.00 is 6 days past due and payment retries have stopped.",
    personal: true,
    hoursAgo: 5,
    readAfterHours: null,
  },
  {
    type: "CHURN_ALERT",
    title: "Churn alert",
    body: "Bell & Co cancelled their Pro subscription. $199.00 of MRR ends with the current period.",
    personal: false,
    hoursAgo: 21,
    readAfterHours: null,
  },
  {
    type: "INVOICE_PAID",
    title: "Invoice paid",
    body: "Redwood Health settled their Pro plan invoice for $199.00.",
    personal: false,
    hoursAgo: 33,
    readAfterHours: 3,
  },
  {
    type: "MEMBER_JOINED",
    title: "Priya Raman joined the workspace",
    body: "Priya accepted your invite and now has the Member role.",
    personal: true,
    hoursAgo: 52,
    readAfterHours: 2,
  },
  {
    type: "REVENUE_DIP",
    title: "Revenue dip detected",
    body: "MRR fell 12% week over week, driven by two downgrades from Pro to Starter.",
    personal: false,
    hoursAgo: 78,
    readAfterHours: 5,
  },
  {
    type: "REPORT_READY",
    title: "Monthly revenue report ready",
    body: "Your revenue and retention summary for last month is ready to download.",
    personal: true,
    hoursAgo: 101,
    readAfterHours: 9,
  },
  {
    type: "SYSTEM",
    title: "Nightly backup completed",
    body: "The scheduled database backup finished in 42 seconds with no errors.",
    personal: false,
    hoursAgo: 149,
    readAfterHours: 14,
  },
  {
    type: "INVOICE_PAID",
    title: "Annual invoice paid",
    body: "Lumen Freight renewed on the annual Pro plan — $2,148.00 collected.",
    personal: false,
    hoursAgo: 197,
    readAfterHours: 6,
  },
  {
    type: "SYSTEM",
    title: "API rate limit raised",
    body: "This workspace can now make 10,000 API requests per minute.",
    personal: false,
    hoursAgo: 268,
    readAfterHours: 20,
  },
];

/**
 * Writes the demo org's notification feed. Returns how many rows were created.
 *
 * Scoped to ONE organization on purpose: the feed is what the signed-in demo
 * operator sees, and fanning identical copies out to all eight tenants would make
 * the org filter look decorative when it is the security boundary.
 */
async function seedNotifications(
  organizationId: string,
  demoUserId: string,
): Promise<number> {
  const rows: Prisma.NotificationCreateManyInput[] = NOTIFICATION_SPECS.map((spec) => {
    if (spec.hoursAgo < 0 || spec.hoursAgo > FEED_WINDOW_DAYS * 24) {
      throw new Error(
        `Notification "${spec.title}" is ${spec.hoursAgo}h old, outside the ${FEED_WINDOW_DAYS}-day feed window.`,
      );
    }
    if (spec.readAfterHours !== null && spec.readAfterHours > spec.hoursAgo) {
      throw new Error(
        `Notification "${spec.title}" would be read in the future (readAfterHours > hoursAgo).`,
      );
    }

    const createdAt = addHoursUTC(FEED_NOW, -spec.hoursAgo);

    return {
      organizationId,
      userId: spec.personal ? demoUserId : null,
      type: spec.type,
      title: spec.title,
      body: spec.body,
      createdAt,
      readAt:
        spec.readAfterHours === null ? null : addHoursUTC(createdAt, spec.readAfterHours),
    };
  });

  await prisma.notification.createMany({ data: rows });

  const unread = await prisma.notification.count({
    where: { organizationId, readAt: null },
  });
  if (unread !== EXPECTED_UNREAD) {
    throw new Error(
      `Invariant violated: expected ${EXPECTED_UNREAD} unread notifications, found ${unread}.`,
    );
  }

  return rows.length;
}

// ---------------------------------------------------------------------------
// Seed run.
// ---------------------------------------------------------------------------

async function clearSeedData(): Promise<void> {
  // FK-safe order: children before parents. Wrapped so a re-run is all-or-nothing.
  // Notification would cascade from Organization anyway, but it is listed
  // explicitly so this stays a complete inventory of the tables the seed owns.
  await prisma.$transaction([
    prisma.notification.deleteMany(),
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
  // The org the demo user OWNS (spec index 0) — the workspace the dashboard opens
  // on, and the only one that gets a notification feed.
  let demoOrgId: string | null = null;

  for (let orgIndex = 0; orgIndex < ORG_SPECS.length; orgIndex++) {
    const spec = ORG_SPECS[orgIndex];

    const org = await prisma.organization.create({
      data: { name: spec.name, slug: spec.slug },
      select: { id: true },
    });

    // Demo user owns the first org and is a member of the rest (tenant switching).
    const role: Role = orgIndex === 0 ? "OWNER" : "MEMBER";
    if (orgIndex === 0) demoOrgId = org.id;
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

  // ---- Notification feed -------------------------------------------------
  // LAST, deliberately. It depends on both the demo user and the demo org
  // already existing, and nothing above depends on it — so it cannot perturb the
  // creation order or the FK graph the metric reconciliation relies on.
  if (demoOrgId === null) {
    throw new Error("Invariant violated: demo organization was never created.");
  }
  const notificationCount = await seedNotifications(demoOrgId, demoUser.id);
  console.log(
    `  notifications : ${notificationCount} for ${ORG_SPECS[0].slug} ` +
      `(${EXPECTED_UNREAD} unread, last ${FEED_WINDOW_DAYS} days)`,
  );
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