/**
 * Verifies every metric definition in lib/metrics.ts and lib/snapshot-formula.ts
 * against a tiny, hand-computed fixture. Run: `npm run verify:metrics`
 * (ts-node through scripts/ts-runtime.cjs, the same runner as the seed).
 *
 * It writes two throwaway workspaces, asserts, and deletes them again by id —
 * nothing else in the database is touched. Exits non-zero on any mismatch.
 *
 * ---------------------------------------------------------------------------
 * The fixture (all instants UTC midnight). Plans: Basic 100.00/mo,
 * Team 1,200.00/yr (= 100.00/mo), Pro 900.00/quarter (= 300.00/mo).
 *
 *   Alpha   NEW          Basic ×1 from 2025-01-15                        100.00/mo
 *   Bravo   UPGRADE      Basic ×2 (200.00/mo) 2024-12-01 → 2025-01-20,
 *                        then Pro ×1 (300.00/mo, quarterly) from 2025-01-20
 *   Charlie DOWNGRADE    Team yearly (100.00/mo) 2024-11-01 → 2025-01-10,
 *                        then a custom 60.00/mo (no plan) from 2025-01-10
 *   Delta   CHURN        Basic ×1 2024-10-01 → cancelled 2025-01-25
 *   Echo    REACTIVATION Basic ×1 2024-09-01 → cancelled 2024-11-15,
 *                        back on Pro (300.00/mo) from 2025-01-05, unlinked
 *
 * Period P = (2025-01-01, 2025-02-01].
 *   MRR at 2025-01-01 = Bravo 200 + Charlie 100 + Delta 100            = 400.00
 *   MRR at 2025-02-01 = Alpha 100 + Bravo 300 + Charlie 60 + Echo 300   = 760.00
 *   Cohort at 01-01 = {Bravo, Charlie, Delta}, starting 400.00:
 *     expansion 100 (Bravo) · contraction 40 (Charlie) · churn 100 (Delta)
 *     NRR = (400 + 100 − 40 − 100) / 400 = 0.9
 *     customer churn = 1/3 · revenue churn = 100/400 = 0.25
 *   Bridge for January: new 100 (Alpha) + reactivation 300 (Echo)
 *     400 + 100 + 300 + 100 − 40 − 100 = 760 ✓
 * ---------------------------------------------------------------------------
 */
import type { BillingInterval } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { verifyApi } from "./verify-api";
import { verifyBillingLifecycle } from "./verify-billing-ops";
import { verifyEmail } from "./verify-email";
import { verifyNotifications } from "./verify-notifications";
import { verifyImports } from "./verify-import";
import {
  getChurnRateTrend,
  getCustomerActivity,
  getCustomerList,
  getMRRTrend,
  getMetricsSummary,
  getNetRevenueRetention,
  getPlanMix,
  getRevenueMovement,
  type Period,
} from "@/lib/metrics";
import {
  computeDaySnapshot,
  DAY_MS,
  firstActiveAt,
  roundedMonthlyCents,
  type SnapshotSegment,
} from "@/lib/snapshot-formula";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const same =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-9
      : JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
  }
}

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface SegmentSpec {
  readonly key: string;
  readonly customer: string;
  readonly plan: "Basic" | "Team" | "Pro" | null;
  readonly amountCents: number;
  readonly quantity: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly canceled: boolean;
  readonly previous: string | null;
}

const PLANS = {
  Basic: { amountCents: 10_000, interval: "MONTH", intervalCount: 1 },
  Team: { amountCents: 120_000, interval: "YEAR", intervalCount: 1 },
  Pro: { amountCents: 90_000, interval: "MONTH", intervalCount: 3 },
} as const;

const SEGMENTS: readonly SegmentSpec[] = [
  { key: "A", customer: "Alpha", plan: "Basic", amountCents: 10_000, quantity: 1, interval: "MONTH", intervalCount: 1, startedAt: "2025-01-15", endedAt: null, canceled: false, previous: null },
  { key: "B1", customer: "Bravo", plan: "Basic", amountCents: 10_000, quantity: 2, interval: "MONTH", intervalCount: 1, startedAt: "2024-12-01", endedAt: "2025-01-20", canceled: false, previous: null },
  { key: "B2", customer: "Bravo", plan: "Pro", amountCents: 90_000, quantity: 1, interval: "MONTH", intervalCount: 3, startedAt: "2025-01-20", endedAt: null, canceled: false, previous: "B1" },
  { key: "C1", customer: "Charlie", plan: "Team", amountCents: 120_000, quantity: 1, interval: "YEAR", intervalCount: 1, startedAt: "2024-11-01", endedAt: "2025-01-10", canceled: false, previous: null },
  { key: "C2", customer: "Charlie", plan: null, amountCents: 6_000, quantity: 1, interval: "MONTH", intervalCount: 1, startedAt: "2025-01-10", endedAt: null, canceled: false, previous: "C1" },
  { key: "D", customer: "Delta", plan: "Basic", amountCents: 10_000, quantity: 1, interval: "MONTH", intervalCount: 1, startedAt: "2024-10-01", endedAt: "2025-01-25", canceled: true, previous: null },
  { key: "E1", customer: "Echo", plan: "Basic", amountCents: 10_000, quantity: 1, interval: "MONTH", intervalCount: 1, startedAt: "2024-09-01", endedAt: "2024-11-15", canceled: true, previous: null },
  { key: "E2", customer: "Echo", plan: "Pro", amountCents: 90_000, quantity: 1, interval: "MONTH", intervalCount: 3, startedAt: "2025-01-05", endedAt: null, canceled: false, previous: null },
];

async function createFixture(stamp: string): Promise<{ organizationId: string; segments: SnapshotSegment[] }> {
  const org = await prisma.organization.create({
    data: { name: "verify-metrics fixture", slug: `verify-metrics-${stamp}`, currency: "USD" },
    select: { id: true },
  });

  const planIds = new Map<string, string>();
  for (const [name, terms] of Object.entries(PLANS)) {
    const plan = await prisma.plan.create({
      data: { organizationId: org.id, name, ...terms },
      select: { id: true },
    });
    planIds.set(name, plan.id);
  }

  const customerIds = new Map<string, string>();
  for (const name of [...new Set(SEGMENTS.map((segment) => segment.customer))]) {
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, name, email: `${name.toLowerCase()}@fixture.example` },
      select: { id: true },
    });
    customerIds.set(name, customer.id);
  }

  const segmentIds = new Map<string, string>();
  const segments: SnapshotSegment[] = [];
  for (const spec of SEGMENTS) {
    const created = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        customerId: customerIds.get(spec.customer) ?? "",
        planId: spec.plan === null ? null : (planIds.get(spec.plan) ?? null),
        status: spec.endedAt === null ? "ACTIVE" : "CANCELED",
        amountCents: spec.amountCents,
        quantity: spec.quantity,
        interval: spec.interval,
        intervalCount: spec.intervalCount,
        startedAt: day(spec.startedAt),
        endedAt: spec.endedAt === null ? null : day(spec.endedAt),
        canceledAt: spec.canceled && spec.endedAt !== null ? day(spec.endedAt) : null,
        previousSubscriptionId: spec.previous === null ? null : (segmentIds.get(spec.previous) ?? null),
      },
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
    segmentIds.set(spec.key, created.id);
    segments.push(created);
  }

  // Daily snapshots for (2024-12-31 .. 2025-02-01], from the same formula the
  // cron and the sample data use — getCustomerActivity and getMRRTrend read them.
  const firstActive = firstActiveAt(segments);
  const rows = [];
  for (let ms = day("2025-01-01").getTime(); ms <= day("2025-02-01").getTime(); ms += DAY_MS) {
    rows.push({ organizationId: org.id, date: new Date(ms), ...computeDaySnapshot(segments, new Date(ms), firstActive) });
  }
  await prisma.metricSnapshot.createMany({ data: rows });

  return { organizationId: org.id, segments };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function verifySnapshotFormula(segments: SnapshotSegment[]): Promise<void> {
  console.log("\nlib/snapshot-formula.ts — daily rows (state at D, flows in (D−1, D])");
  const at = (iso: string) => computeDaySnapshot(segments, day(iso));

  const jan05 = at("2025-01-05");
  check("2025-01-05 Echo returns: MRR 700.00", jan05.mrrCents, 70_000);
  check("2025-01-05 active customers (Bravo, Charlie, Delta, Echo)", jan05.activeCustomers, 4);
  check("2025-01-05 a returning customer is NOT new", jan05.newCustomers, 0);
  check("2025-01-05 new subscriptions (Echo's)", jan05.newSubs, 1);

  const jan15 = at("2025-01-15");
  check("2025-01-15 Alpha starts: MRR 760.00", jan15.mrrCents, 76_000);
  check("2025-01-15 active customers", jan15.activeCustomers, 5);
  check("2025-01-15 new customers (Alpha)", jan15.newCustomers, 1);

  const jan20 = at("2025-01-20");
  check("2025-01-20 Bravo upgrades: MRR 860.00", jan20.mrrCents, 86_000);
  check("2025-01-20 a plan change is not churn (churnedSubs)", jan20.churnedSubs, 0);
  check("2025-01-20 a plan change is not a new customer", jan20.newCustomers, 0);
  check("2025-01-20 …but it is a new subscription", jan20.newSubs, 1);

  const jan25 = at("2025-01-25");
  check("2025-01-25 Delta cancels: churned customers", jan25.churnedCustomers, 1);
  check("2025-01-25 churned subscriptions", jan25.churnedSubs, 1);
  check("2025-01-25 active customers", jan25.activeCustomers, 4);
  check("2025-01-25 MRR 760.00", jan25.mrrCents, 76_000);

  check("2024-11-15 Echo cancels the first time: churned customers", at("2024-11-15").churnedCustomers, 1);

  const threeYearlyDollars = Array.from({ length: 3 }, () => ({
    amountCents: 100,
    quantity: 1,
    interval: "YEAR" as const,
    intervalCount: 1,
  }));
  check("round ONCE: 3 × 1.00/yr = 25¢ MRR (per-row rounding would give 24¢)", roundedMonthlyCents(threeYearlyDollars), 25);
  check("quantity multiplies: Basic × 2 = 200.00", roundedMonthlyCents([{ amountCents: 10_000, quantity: 2, interval: "MONTH", intervalCount: 1 }]), 20_000);
  check("quarterly = amount ÷ 3: 900.00/quarter = 300.00", roundedMonthlyCents([{ amountCents: 90_000, quantity: 1, interval: "MONTH", intervalCount: 3 }]), 30_000);
  check("yearly = amount ÷ 12: 1,200.00/yr = 100.00", roundedMonthlyCents([{ amountCents: 120_000, quantity: 1, interval: "YEAR", intervalCount: 1 }]), 10_000);
}

async function verifySql(organizationId: string, segments: SnapshotSegment[]): Promise<void> {
  const period: Period = { kind: "range", start: day("2025-01-01"), end: day("2025-02-01") };

  console.log("\ngetMetricsSummary — P = (2025-01-01, 2025-02-01], previous = (2024-12-01, 2025-01-01]");
  const summary = await getMetricsSummary(organizationId, period);
  check("currency is the workspace's", summary.currency, "USD");
  check("MRR at end", summary.mrrCents.current, 76_000);
  check("MRR at previous end", summary.mrrCents.previous, 40_000);
  check("ARR = MRR × 12", summary.arrCents.current, 912_000);
  check("active customers at end", summary.activeCustomers.current, 4);
  check("active customers at previous end", summary.activeCustomers.previous, 3);
  check("live subscriptions at end (A, B2, C2, E2)", summary.activeSubscriptions.current, 4);
  check("customer churn = 1/3", summary.customerChurnRate.current, 1 / 3);
  check("revenue churn = 100/400", summary.revenueChurnRate.current, 0.25);
  check("previous period: nobody churned", summary.customerChurnRate.previous, 0);
  check("live MRR agrees with the snapshot formula to the cent", summary.mrrCents.current, computeDaySnapshot(segments, day("2025-02-01")).mrrCents);

  console.log("\ngetNetRevenueRetention — P");
  const nrr = await getNetRevenueRetention(organizationId, period);
  check("cohort = customers active at the start", nrr.cohortCustomers, 3);
  check("starting MRR", nrr.startingMRRCents, 40_000);
  check("expansion (Bravo)", nrr.expansionMRRCents, 10_000);
  check("contraction (Charlie)", nrr.contractionMRRCents, 4_000);
  check("churned MRR (Delta)", nrr.churnedMRRCents, 10_000);
  check("churned customers", nrr.churnedCustomers, 1);
  check("cohort ending MRR (new customers excluded)", nrr.endingMRRCents, 36_000);
  check("NRR = 0.9", nrr.nrr, 0.9);

  console.log("\ngetRevenueMovement — Jan and Feb 2025, asOf 2025-03-01");
  const movement = await getRevenueMovement(organizationId, 3, day("2025-03-01"));
  const jan = movement.find((point) => point.month === "2025-01");
  const feb = movement.find((point) => point.month === "2025-02");
  check("two complete months", movement.map((point) => [point.month, point.isComplete]), [["2025-01", true], ["2025-02", true]]);
  check("Jan starting", jan?.startingMRRCents, 40_000);
  check("Jan new (Alpha — never active before)", jan?.newMRRCents, 10_000);
  check("Jan reactivation (Echo — active before, reported separately)", jan?.reactivationMRRCents, 30_000);
  check("Jan expansion (Bravo)", jan?.expansionMRRCents, 10_000);
  check("Jan contraction (Charlie)", jan?.contractionMRRCents, 4_000);
  check("Jan churned (Delta)", jan?.churnedMRRCents, 10_000);
  check("Jan ending", jan?.endingMRRCents, 76_000);
  check(
    "Jan identity: start + new + reactivation + expansion − contraction − churn = end",
    jan === undefined
      ? null
      : jan.startingMRRCents + jan.newMRRCents + jan.reactivationMRRCents + jan.expansionMRRCents - jan.contractionMRRCents - jan.churnedMRRCents,
    76_000,
  );
  check("Jan customer counts [paying at start, new, reactivated, churned]", jan === undefined ? null : [jan.payingCustomersAtStart, jan.newCustomers, jan.reactivatedCustomers, jan.churnedCustomers], [3, 1, 1, 1]);
  check("Jan NRR", jan?.nrr, 0.9);
  check("Jan GRR = (400 − 40 − 100)/400", jan?.grr, 0.65);
  check("Feb flat: start = end = 760.00", feb === undefined ? null : [feb.startingMRRCents, feb.endingMRRCents], [76_000, 76_000]);
  check("Feb paying customers at start", feb?.payingCustomersAtStart, 4);

  console.log("\ngetChurnRateTrend — same windows");
  const churn = await getChurnRateTrend(organizationId, 3, day("2025-03-01"));
  const janChurn = churn.find((point) => point.month === "2025-01");
  check("Jan customer churn: 1 of 3", janChurn === undefined ? null : [janChurn.churnedCustomers, janChurn.customersAtStart], [1, 3]);
  check("Jan customer churn rate", janChurn?.rate, 1 / 3);
  check("Jan revenue churn rate", janChurn?.revenueRate, 0.25);
  check("Feb customer churn rate", churn.find((point) => point.month === "2025-02")?.rate, 0);

  console.log("\ngetPlanMix — at 2025-02-01");
  const mix = await getPlanMix(organizationId, day("2025-02-01"));
  check("total equals headline MRR", mix.totalMRRCents, 76_000);
  check(
    "by plan, highest MRR first; no plan = Custom",
    mix.byPlan.map((entry) => [entry.name, entry.mrrCents, entry.subscriptions]),
    [["Pro", 60_000, 2], ["Basic", 10_000, 1], ["Custom", 6_000, 1]],
  );

  console.log("\ngetCustomerList — at 2025-02-01");
  const list = await getCustomerList(organizationId, day("2025-02-01"));
  const row = (name: string) => list.customers.find((customer) => customer.name === name);
  check("active / churned counts", [list.activeCount, list.churnedCount], [4, 1]);
  check("ARPA = 760 / 4", list.averageMRRCents, 19_000);
  check("Delta is churned on 2025-01-25", [row("Delta")?.state, row("Delta")?.churnedAt?.toISOString()], ["churned", "2025-01-25T00:00:00.000Z"]);
  check("Echo is a customer since their FIRST payment", row("Echo")?.customerSince?.toISOString(), "2024-09-01T00:00:00.000Z");
  check("Charlie's live plan is Custom at 60.00", [row("Charlie")?.livePlans, row("Charlie")?.mrrCents], ["Custom", 6_000]);

  console.log("\ngetCustomerActivity / getMRRTrend — from the snapshots");
  const activity = await getCustomerActivity(organizationId, period);
  check("active customers from the latest snapshot", activity.activeCustomers.current, 4);
  check("new customers in P (Alpha only — Echo is a reactivation)", activity.newCustomers.current, 1);
  check("churned customers in P (Delta)", activity.churnedCustomers.current, 1);
  const trend = await getMRRTrend(organizationId, 12);
  check(
    "month-end trend [month, MRR, active, new, churned]",
    trend.map((point) => [point.month, point.mrrCents, point.activeCustomers, point.newCustomers, point.churnedCustomers]),
    [["2025-01", 76_000, 4, 1, 1], ["2025-02", 76_000, 4, 0, 0]],
  );
}

async function verifyRoundingInSql(stamp: string): Promise<string> {
  console.log("\nSQL rounding — three 1.00/yr subscriptions");
  const org = await prisma.organization.create({
    data: { name: "verify-metrics rounding", slug: `verify-metrics-rounding-${stamp}` },
    select: { id: true },
  });
  const customer = await prisma.customer.create({
    data: { organizationId: org.id, name: "Rounding" },
    select: { id: true },
  });
  await prisma.subscription.createMany({
    data: Array.from({ length: 3 }, () => ({
      organizationId: org.id,
      customerId: customer.id,
      amountCents: 100,
      interval: "YEAR" as const,
      startedAt: day("2025-01-01"),
    })),
  });
  const summary = await getMetricsSummary(org.id, { kind: "range", start: day("2025-01-01"), end: day("2025-02-01") });
  check("SQL rounds once too: 25¢, not 24¢", summary.mrrCents.current, 25);
  return org.id;
}

async function main(): Promise<void> {
  const stamp = String(Date.now());
  const created: string[] = [];
  try {
    const fixture = await createFixture(stamp);
    created.push(fixture.organizationId);
    await verifySnapshotFormula(fixture.segments);
    await verifySql(fixture.organizationId, fixture.segments);
    created.push(await verifyRoundingInSql(stamp));
    created.push(...(await verifyBillingLifecycle(check, stamp)));
    created.push(...(await verifyImports(check, stamp)));
    created.push(...(await verifyApi(check, stamp)));
    created.push(...(await verifyEmail(check, stamp)));
    created.push(...(await verifyNotifications(check, stamp)));
  } finally {
    // By id only: the workspaces this run created, and their cascade.
    if (created.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: created } } });
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) throw new Error(`${failures} metric check(s) failed`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
