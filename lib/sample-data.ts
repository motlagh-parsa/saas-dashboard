import "server-only";

// Sample billing data for ONE workspace: plans, customers, 18 months of
// subscription history with real lifecycle events, invoices, and the daily
// MetricSnapshot rows computed from it.
//
// Every row written here has `source = SAMPLE`, and `removeSampleData` deletes
// only those rows — never anything a founder entered or imported, and never
// another workspace's data. This replaces the old seed's unfiltered wipe.
//
// Deterministic: no Math.random(). Every choice is a pure function of the
// customer's index, so two runs with the same anchor date write identical data.
// The one moving input is the anchor (default: today, UTC), so the dashboard's
// "last 30 days" always lands on history.
import type { BillingInterval, InvoiceStatus, Prisma, SubscriptionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  DAY_MS,
  computeDaySnapshot,
  firstActiveAt,
  monthsInInterval,
  utcDayStart,
  type SnapshotSegment,
} from "@/lib/snapshot-formula";

const HISTORY_MONTHS = 18;
const CUSTOMER_COUNT = 60;
/** Invoices issued this recently are still awaiting payment. */
const OPEN_INVOICE_DAYS = 7;
const PAYMENT_TERMS_DAYS = 14;
const PAID_AFTER_DAYS = 2;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

type PlanKey = "starter" | "growth" | "pro" | "pro-annual" | "enterprise";

interface PlanSpec {
  readonly key: PlanKey;
  readonly name: string;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
}

const PLANS: readonly PlanSpec[] = [
  { key: "starter", name: "Starter", amountCents: 2_900, interval: "MONTH", intervalCount: 1 },
  { key: "growth", name: "Growth", amountCents: 7_900, interval: "MONTH", intervalCount: 1 },
  { key: "pro", name: "Pro", amountCents: 19_900, interval: "MONTH", intervalCount: 1 },
  { key: "pro-annual", name: "Pro (annual)", amountCents: 199_000, interval: "YEAR", intervalCount: 1 },
  // Billed quarterly: MONTH × 3, Stripe-style.
  { key: "enterprise", name: "Enterprise", amountCents: 150_000, interval: "MONTH", intervalCount: 3 },
];

/** Rank for upgrades and downgrades. Pro (annual) sits beside Pro, not above it. */
const LADDER: readonly PlanKey[] = ["starter", "growth", "pro", "enterprise"];

/** A negotiated deal: no plan, its own price. */
const CUSTOM_DEAL = { amountCents: 420_000, interval: "YEAR", intervalCount: 1 } as const;

const NAME_HEADS = [
  "Bluebird", "Cobalt", "Driftwood", "Evergreen", "Foxglove", "Granite",
  "Harborline", "Ironbark", "Juniper", "Kestrel", "Lumen", "Meadowlark",
] as const;
const NAME_TAILS = ["Labs", "Analytics", "Health", "Logistics", "Studio", "Systems"] as const;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/**
 * Stable, deterministic string hash: FNV-1a, then murmur3's fmix32 finalizer.
 * The finalizer matters — the keys differ only in their last digits, and plain
 * FNV/djb2 leave the high bits (which the lifecycle model slices) barely mixed.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Calendar-month arithmetic that clamps the day (Jan 31 + 1 month => Feb 28/29). */
function addMonthsUTC(value: Date, months: number): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(value.getUTCDate(), lastDay)));
}

function addDaysUTC(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function planByKey(key: PlanKey): PlanSpec {
  const plan = PLANS.find((candidate) => candidate.key === key);
  if (plan === undefined) throw new Error(`Unknown sample plan "${key}"`);
  return plan;
}

function customerName(index: number): string {
  const head = NAME_HEADS[index % NAME_HEADS.length];
  const tail = NAME_TAILS[Math.floor(index / NAME_HEADS.length) % NAME_TAILS.length];
  return `${head} ${tail}`;
}

function emailFor(name: string): string {
  // `.example` is reserved (RFC 2606): these addresses can never reach anyone.
  return `billing@${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`;
}

// ---------------------------------------------------------------------------
// Lifecycle model
// ---------------------------------------------------------------------------

/** One segment before it is written: price terms plus its lifecycle facts. */
interface DraftSegment {
  readonly id: string;
  readonly customerId: string;
  readonly planKey: PlanKey | null;
  readonly amountCents: number;
  readonly quantity: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly startedAt: Date;
  endedAt: Date | null;
  canceledAt: Date | null;
  status: SubscriptionStatus;
  readonly previousSubscriptionId: string | null;
  /** The customer's final invoice before a cancellation is written off. */
  writeOffLastInvoice: boolean;
}

type Pattern =
  | "steady"
  | "upgrade"
  | "downgrade"
  | "churn"
  | "reactivate"
  | "past-due"
  | "custom"
  | "upgrade-then-downgrade";

/** The pattern mix: mostly steady and growing, with a realistic tail of churn. */
function patternFor(h: number): Pattern {
  const bucket = (h >>> 7) % 20;
  if (bucket <= 4) return "steady";
  if (bucket <= 8) return "upgrade";
  if (bucket <= 10) return "downgrade";
  if (bucket <= 14) return "churn";
  if (bucket <= 16) return "reactivate";
  if (bucket === 17) return "past-due";
  if (bucket === 18) return "custom";
  return "upgrade-then-downgrade";
}

function initialPlanFor(h: number): PlanKey {
  const roll = (h >>> 3) % 100;
  if (roll < 35) return "starter";
  if (roll < 65) return "growth";
  if (roll < 83) return "pro";
  if (roll < 95) return "pro-annual";
  return "enterprise";
}

function stepPlan(key: PlanKey, direction: 1 | -1): PlanKey | null {
  // Annual Pro moves along the ladder as Pro does.
  const rank = LADDER.indexOf(key === "pro-annual" ? "pro" : key);
  const next = LADDER[rank + direction];
  return next ?? null;
}

interface CustomerDraft {
  readonly id: string;
  readonly name: string;
  readonly segments: DraftSegment[];
}

/**
 * Builds one customer's segments. Plan changes end a segment and start the next
 * on the same instant with `previousSubscriptionId` set; a cancellation ends a
 * segment with `canceledAt`; a reactivation starts a new, unlinked segment after
 * a gap. Nothing is dated on or after `anchor`.
 */
function buildCustomer(
  organizationId: string,
  index: number,
  windowStart: Date,
  anchor: Date,
  nextSegmentId: () => string,
): CustomerDraft {
  const h = hash(`customer:${index}`);
  const id = `${organizationId}-cus-${String(index).padStart(3, "0")}`;
  const name = customerName(index);
  const pattern = patternFor(h);

  // New customers every month: the 60 starts are spread over the 18 months.
  const startMonth = Math.floor((index * HISTORY_MONTHS) / CUSTOMER_COUNT);
  const startedAt = addDaysUTC(addMonthsUTC(windowStart, startMonth), h % 26);
  const segments: DraftSegment[] = [];
  if (startedAt.getTime() >= anchor.getTime()) return { id, name, segments };

  let planKey: PlanKey = pattern === "custom" ? "enterprise" : initialPlanFor(h);
  let quantity = (planKey === "growth" || planKey === "pro") && (h >>> 5) % 4 === 0 ? 2 + ((h >>> 11) % 3) : 1;

  const open = (at: Date, previous: DraftSegment | null, custom: boolean): DraftSegment => {
    const plan = planByKey(planKey);
    const segment: DraftSegment = {
      id: nextSegmentId(),
      customerId: id,
      planKey: custom ? null : planKey,
      amountCents: custom ? CUSTOM_DEAL.amountCents : plan.amountCents,
      quantity,
      interval: custom ? CUSTOM_DEAL.interval : plan.interval,
      intervalCount: custom ? CUSTOM_DEAL.intervalCount : plan.intervalCount,
      startedAt: at,
      endedAt: null,
      canceledAt: null,
      status: "ACTIVE",
      previousSubscriptionId: previous?.id ?? null,
      writeOffLastInvoice: false,
    };
    segments.push(segment);
    return segment;
  };

  const before = (at: Date): boolean => at.getTime() < anchor.getTime();
  const firstEventAfter = 3 + ((h >>> 9) % 6);

  let current = open(startedAt, null, pattern === "custom");

  /** Ends `current` and opens the next segment on the same instant. */
  const changePlan = (at: Date, nextKey: PlanKey | null, nextQuantity: number): void => {
    if (!before(at) || (nextKey === planKey && nextQuantity === quantity)) return;
    current.endedAt = at;
    current.status = "CANCELED";
    planKey = nextKey ?? planKey;
    quantity = nextQuantity;
    current = open(at, current, false);
  };

  const cancel = (at: Date): boolean => {
    if (!before(at)) return false;
    current.endedAt = at;
    current.canceledAt = at;
    current.status = "CANCELED";
    return true;
  };

  const eventAt = addMonthsUTC(startedAt, firstEventAfter);

  switch (pattern) {
    case "upgrade": {
      // Enterprise has nowhere to go but more seats.
      const next = stepPlan(planKey, 1);
      changePlan(eventAt, next, next === null ? quantity + 1 : quantity);
      break;
    }
    case "downgrade": {
      const next = stepPlan(planKey, -1);
      if (next !== null) changePlan(eventAt, next, 1);
      else if (quantity > 1) changePlan(eventAt, planKey, quantity - 1);
      break;
    }
    case "upgrade-then-downgrade": {
      const up = stepPlan(planKey, 1);
      changePlan(eventAt, up, up === null ? quantity + 1 : quantity);
      const down = stepPlan(planKey, -1);
      if (down !== null) changePlan(addMonthsUTC(eventAt, 4), down, quantity);
      break;
    }
    case "churn": {
      if (cancel(eventAt)) current.writeOffLastInvoice = (h >>> 13) % 3 === 0;
      break;
    }
    case "reactivate": {
      if (cancel(eventAt)) {
        // Back after a gap, on a fresh, unlinked subscription: a reactivation.
        const returnAt = addMonthsUTC(eventAt, 2 + ((h >>> 15) % 3));
        if (before(returnAt)) {
          planKey = stepPlan(planKey, -1) ?? planKey;
          quantity = 1;
          current = open(returnAt, null, false);
        }
      }
      break;
    }
    case "past-due":
      current.status = "PAST_DUE";
      break;
    case "steady":
    case "custom":
      break;
  }

  return { id, name, segments };
}

interface DraftInvoice {
  readonly id: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly amountCents: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly dueAt: Date;
  readonly paidAt: Date | null;
}

/**
 * One invoice per billing period of a segment, issued on the period's first day,
 * while the segment is live and before the anchor.
 */
function invoicesFor(
  segment: DraftSegment,
  anchor: Date,
  nextInvoiceId: () => string,
): DraftInvoice[] {
  const months = monthsInInterval(segment.interval, segment.intervalCount);
  const stopAt = Math.min(segment.endedAt?.getTime() ?? Number.POSITIVE_INFINITY, anchor.getTime());
  const issued: Date[] = [];
  for (let at = segment.startedAt; at.getTime() < stopAt; at = addMonthsUTC(at, months)) {
    issued.push(at);
  }

  const amountCents = segment.amountCents * segment.quantity;
  if (amountCents === 0) return [];
  const openFrom = anchor.getTime() - OPEN_INVOICE_DAYS * DAY_MS;

  return issued.map((issuedAt, index) => {
    const isLast = index === issued.length - 1;
    let status: InvoiceStatus = "PAID";
    if (segment.status === "PAST_DUE" && index >= issued.length - 2) status = "OPEN";
    else if (segment.writeOffLastInvoice && isLast) status = "UNCOLLECTIBLE";
    else if (issuedAt.getTime() >= openFrom && segment.endedAt === null) status = "OPEN";

    return {
      id: nextInvoiceId(),
      customerId: segment.customerId,
      subscriptionId: segment.id,
      amountCents,
      status,
      issuedAt,
      dueAt: addDaysUTC(issuedAt, PAYMENT_TERMS_DAYS),
      paidAt: status === "PAID" ? addDaysUTC(issuedAt, PAID_AFTER_DAYS) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SampleDataSummary {
  readonly plans: number;
  readonly customers: number;
  readonly subscriptions: number;
  readonly invoices: number;
  readonly snapshots: number;
}

/**
 * Writes sample billing data into ONE workspace: 5 plans, 60 customers, 18
 * months of subscription history ending at `anchorDate` (default: today, UTC),
 * an invoice per billing period, and the workspace's daily snapshots.
 *
 * Call `removeSampleData` first to replace an earlier run — sample ids are
 * deterministic, so a second run on top of the first would collide.
 *
 * Snapshots are recomputed from the workspace's WHOLE subscription history —
 * sample rows and any real ones — because the trend chart is one series per
 * workspace. Existing snapshot rows in the window are replaced.
 */
export async function generateSampleData(
  organizationId: string,
  options: { anchorDate?: Date } = {},
): Promise<SampleDataSummary> {
  const anchor = utcDayStart(options.anchorDate ?? new Date());
  const windowStart = addMonthsUTC(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)), -HISTORY_MONTHS);

  let segmentCounter = 0;
  let invoiceCounter = 0;
  const nextSegmentId = (): string => `${organizationId}-sub-${String(++segmentCounter).padStart(4, "0")}`;
  const nextInvoiceId = (): string => `${organizationId}-inv-${String(++invoiceCounter).padStart(5, "0")}`;

  const customers = Array.from({ length: CUSTOMER_COUNT }, (_, index) =>
    buildCustomer(organizationId, index, windowStart, anchor, nextSegmentId),
  );
  const segments = customers.flatMap((customer) => customer.segments);
  const invoices = segments.flatMap((segment) => invoicesFor(segment, anchor, nextInvoiceId));

  return prisma.$transaction(
    async (tx) => {
      // A founder's own plan may already use one of these names (unique per
      // workspace); the sample one steps aside rather than failing.
      const taken = new Set(
        (
          await tx.plan.findMany({ where: { organizationId }, select: { name: true } })
        ).map((plan) => plan.name),
      );
      const planIds = new Map<PlanKey, string>();
      const planRows: Prisma.PlanCreateManyInput[] = PLANS.map((plan) => {
        const planId = `${organizationId}-plan-${plan.key}`;
        planIds.set(plan.key, planId);
        return {
          id: planId,
          organizationId,
          name: taken.has(plan.name) ? `${plan.name} (sample)` : plan.name,
          amountCents: plan.amountCents,
          interval: plan.interval,
          intervalCount: plan.intervalCount,
          source: "SAMPLE",
        };
      });
      await tx.plan.createMany({ data: planRows });

      await tx.customer.createMany({
        data: customers.map((customer) => ({
          id: customer.id,
          organizationId,
          name: customer.name,
          email: emailFor(customer.name),
          source: "SAMPLE" as const,
        })),
      });

      // Predecessors are always earlier in the array (segments are built in
      // lifecycle order), so the hand-off FK is satisfied row by row.
      await tx.subscription.createMany({
        data: segments.map((segment) => ({
          id: segment.id,
          organizationId,
          customerId: segment.customerId,
          planId: segment.planKey === null ? null : (planIds.get(segment.planKey) ?? null),
          status: segment.status,
          amountCents: segment.amountCents,
          quantity: segment.quantity,
          interval: segment.interval,
          intervalCount: segment.intervalCount,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          canceledAt: segment.canceledAt,
          previousSubscriptionId: segment.previousSubscriptionId,
          source: "SAMPLE" as const,
        })),
      });

      await tx.invoice.createMany({
        data: invoices.map((invoice) => ({ ...invoice, organizationId, source: "SAMPLE" as const })),
      });

      // Snapshots from the workspace's FULL history, sample and real alike.
      const history: SnapshotSegment[] = await tx.subscription.findMany({
        where: { organizationId },
        select: {
          id: true,
          customerId: true,
          amountCents: true,
          quantity: true,
          interval: true,
          intervalCount: true,
          startedAt: true,
          endedAt: true,
          canceledAt: true,
        },
      });
      const firstActive = firstActiveAt(history);
      const snapshotRows: Prisma.MetricSnapshotCreateManyInput[] = [];
      for (let ms = windowStart.getTime(); ms <= anchor.getTime(); ms += DAY_MS) {
        const day = new Date(ms);
        snapshotRows.push({ organizationId, date: day, ...computeDaySnapshot(history, day, firstActive) });
      }
      await tx.metricSnapshot.deleteMany({
        where: { organizationId, date: { gte: windowStart, lte: anchor } },
      });
      await tx.metricSnapshot.createMany({ data: snapshotRows });

      return {
        plans: planRows.length,
        customers: customers.length,
        subscriptions: segments.length,
        invoices: invoices.length,
        snapshots: snapshotRows.length,
      };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

export interface RemovedSampleData {
  readonly invoices: number;
  readonly subscriptions: number;
  readonly customers: number;
  readonly plans: number;
  readonly snapshots: number;
}

/**
 * Deletes ONLY `source = SAMPLE` rows of ONE workspace, plus that workspace's
 * snapshots (which then describe data that no longer exists; recomputing them
 * from what remains is a later step).
 *
 * A sample customer or plan that real data now points at is KEPT: deleting the
 * customer would cascade into the founder's own subscription, and deleting the
 * plan would silently turn their subscription into a custom-priced one.
 */
export async function removeSampleData(organizationId: string): Promise<RemovedSampleData> {
  return prisma.$transaction(
    async (tx) => {
      const invoices = await tx.invoice.deleteMany({ where: { organizationId, source: "SAMPLE" } });
      const subscriptions = await tx.subscription.deleteMany({
        where: { organizationId, source: "SAMPLE" },
      });
      // What remains attached to a sample customer or plan is, by now, real data.
      const customers = await tx.customer.deleteMany({
        where: {
          organizationId,
          source: "SAMPLE",
          subscriptions: { none: {} },
          invoices: { none: {} },
        },
      });
      const plans = await tx.plan.deleteMany({
        where: { organizationId, source: "SAMPLE", subscriptions: { none: {} } },
      });
      const snapshots = await tx.metricSnapshot.deleteMany({ where: { organizationId } });
      // Alerts raised about the sample data (lib/alerts.ts) go with it, and so do
      // their marks, so the remaining real data is judged afresh.
      await tx.notification.deleteMany({
        where: { organizationId, type: { in: ["CHURN_ALERT", "REVENUE_DIP", "INVOICE_OVERDUE", "MRR_MILESTONE"] } },
      });
      await tx.alertMark.deleteMany({ where: { organizationId } });

      return {
        invoices: invoices.count,
        subscriptions: subscriptions.count,
        customers: customers.count,
        plans: plans.count,
        snapshots: snapshots.count,
      };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
