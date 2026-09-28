/**
 * The billing-write half of `npm run verify:metrics`: a customer's lifecycle
 * entered by hand, step by step, through lib/billing-ops.ts — the functions the
 * Server Actions call once they have authorized the caller — followed after each
 * step by lib/snapshots.ts `recomputeSnapshots`, exactly as the actions'
 * `after()` does. After every step it asserts live MRR, customer counts, churn
 * and the stored snapshot rows, and that the rows written by the partial
 * recompute equal a full rebuild of the whole history.
 *
 * All dates are relative to today (T, UTC midnight), because the operations and
 * the recompute run against the real clock.
 *
 *   Plans: Basic 100.00 / month, Pro 300.00 / month.
 *   1. A backdated subscription: Alpha on Basic from T−90, with past invoices.
 *   2. A plan change in the past: Alpha → Pro from T−60.
 *   3. A quantity change: Alpha Pro × 3 from T−30.
 *   4. A past cancellation: Bravo (new, inline) Basic × 2 from T−50, canceled T−20.
 *   5. A future cancellation: Alpha scheduled to cancel T+30, then undone.
 *   6. A corrected start date: Alpha's × 3 terms really began T−40, not T−30.
 *   Plus: refusals (zero-length change, double cancel, another workspace's id)
 *   and "status never contradicts dates".
 */
import { CUSTOM_PRICE, NEW_CUSTOMER } from "@/lib/billing-form";
import {
  cancelSubscriptionOp,
  changeSubscriptionOp,
  correctSubscriptionOp,
  createCustomerOp,
  createPlanOp,
  createSubscriptionOp,
  undoScheduledCancelOp,
  type OpResult,
} from "@/lib/billing-ops";
import { getMetricsSummary } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { DAY_MS, computeDaySnapshot, firstActiveAt, utcDayStart, type SnapshotMetrics } from "@/lib/snapshot-formula";
import { recomputeSnapshots } from "@/lib/snapshots";

type Check = (label: string, actual: unknown, expected: unknown) => void;

const T = utcDayStart(new Date());
const at = (offsetDays: number): Date => new Date(T.getTime() + offsetDays * DAY_MS);

function addMonthsUTC(value: Date, months: number): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(value.getUTCDate(), lastDay)));
}

function must<T>(result: OpResult<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} was refused: ${result.message ?? JSON.stringify(result.fieldErrors)}`);
  }
  return result.value;
}

/** What `finishWrite`'s `after()` does for a successful write. */
async function afterWrite<T>(organizationId: string, result: OpResult<T>, what: string): Promise<T> {
  const value = must(result, what);
  if (result.ok && result.affectedFrom !== null) await recomputeSnapshots(organizationId, result.affectedFrom);
  return value;
}

async function storedRow(organizationId: string, offsetDays: number): Promise<SnapshotMetrics | null> {
  const row = await prisma.metricSnapshot.findUnique({
    where: { organizationId_date: { organizationId, date: at(offsetDays) } },
    select: {
      mrrCents: true,
      activeSubs: true,
      newSubs: true,
      churnedSubs: true,
      activeCustomers: true,
      newCustomers: true,
      churnedCustomers: true,
    },
  });
  return row;
}

/** Every stored row from `fromOffset` to today equals a from-scratch computation of the whole history. */
async function matchesFullRebuild(organizationId: string, fromOffset: number): Promise<{ days: number; mismatches: string[] }> {
  const history = await prisma.subscription.findMany({
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
  const stored = await prisma.metricSnapshot.findMany({
    where: { organizationId, date: { gte: at(fromOffset), lte: T } },
    orderBy: { date: "asc" },
    select: {
      date: true,
      mrrCents: true,
      activeSubs: true,
      newSubs: true,
      churnedSubs: true,
      activeCustomers: true,
      newCustomers: true,
      churnedCustomers: true,
    },
  });
  const mismatches: string[] = [];
  const expectedDays = Math.round((T.getTime() - at(fromOffset).getTime()) / DAY_MS) + 1;
  if (stored.length !== expectedDays) mismatches.push(`expected ${expectedDays} rows, found ${stored.length}`);
  for (const row of stored) {
    const { date, ...values } = row;
    const expected = computeDaySnapshot(history, date, firstActive);
    if (JSON.stringify(values) !== JSON.stringify(expected)) {
      mismatches.push(`${date.toISOString().slice(0, 10)}: ${JSON.stringify(values)} ≠ ${JSON.stringify(expected)}`);
    }
  }
  return { days: stored.length, mismatches };
}

async function liveFigures(organizationId: string) {
  const summary = await getMetricsSummary(organizationId, { kind: "range", start: at(-1), end: new Date() });
  return { mrr: summary.mrrCents.current, customers: summary.activeCustomers.current };
}

export async function verifyBillingLifecycle(check: Check, stamp: string): Promise<string[]> {
  console.log(`\nlib/billing-ops.ts + lib/snapshots.ts — a lifecycle entered by hand (T = ${T.toISOString().slice(0, 10)})`);

  const org = await prisma.organization.create({
    data: { name: "verify-metrics lifecycle", slug: `verify-metrics-lifecycle-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const other = await prisma.organization.create({
    data: { name: "verify-metrics other tenant", slug: `verify-metrics-other-${stamp}`, currency: "USD" },
    select: { id: true },
  });
  const orgId = org.id;
  const created = [org.id, other.id];

  const basic = must(await createPlanOp(orgId, "USD", { name: "Basic", price: 10_000, interval: "MONTH", intervalCount: 1 }), "create Basic");
  const pro = must(await createPlanOp(orgId, "USD", { name: "Pro", price: 30_000, interval: "MONTH", intervalCount: 1 }), "create Pro");
  const duplicate = await createPlanOp(orgId, "USD", { name: "basic", price: 1, interval: "MONTH", intervalCount: 1 });
  check("a duplicate plan name (any case) is a field error", duplicate.ok ? null : duplicate.fieldErrors.name, "A plan with this name already exists in this workspace.");

  // ---- 1. backdated subscription with past invoices -------------------------
  const alpha = must(await createCustomerOp(orgId, { name: "Alpha", email: "alpha@fixture.example" }), "create Alpha");
  const created1 = await afterWrite(
    orgId,
    await createSubscriptionOp(orgId, "USD", {
      customerId: alpha.id,
      newCustomerName: "",
      planId: basic.id,
      price: null,
      interval: null,
      intervalCount: null,
      quantity: 1,
      status: "ACTIVE",
      startDate: at(-90),
      recordPastInvoices: true,
    }),
    "backdated subscription",
  );
  let expectedInvoices = 0;
  while (addMonthsUTC(at(-90), expectedInvoices).getTime() <= T.getTime()) expectedInvoices += 1;
  check("1. past invoices: one PAID per elapsed month", [created1.invoices, await prisma.invoice.count({ where: { organizationId: orgId, status: "PAID" } })], [expectedInvoices, expectedInvoices]);
  let live = await liveFigures(orgId);
  check("1. live MRR 100.00, 1 active customer", [live.mrr, live.customers], [10_000, 1]);
  check("1. snapshot T−91: before the start, nothing", (await storedRow(orgId, -91))?.mrrCents ?? null, null);
  check("1. snapshot T−90: MRR 100.00, a new customer", pick(await storedRow(orgId, -90), "mrrCents", "activeCustomers", "newCustomers"), [10_000, 1, 1]);
  check("1. snapshot today: MRR 100.00", (await storedRow(orgId, 0))?.mrrCents, 10_000);
  let rebuild = await matchesFullRebuild(orgId, -90);
  check("1. recompute from T−90 = full rebuild (91 days)", [rebuild.days, rebuild.mismatches], [91, []]);

  // ---- 2. plan change in the past ---------------------------------------------
  const tooEarly = await changeSubscriptionOp(orgId, "USD", {
    subscriptionId: created1.subscriptionId,
    planId: pro.id,
    price: null,
    interval: null,
    intervalCount: null,
    quantity: 1,
    effectiveDate: at(-90),
  });
  check("2. a change dated on the current start is refused (use Correct)", tooEarly.ok ? "accepted" : Object.keys(tooEarly.fieldErrors), ["effectiveDate"]);
  const change2 = await afterWrite(
    orgId,
    await changeSubscriptionOp(orgId, "USD", {
      subscriptionId: created1.subscriptionId,
      planId: pro.id,
      price: null,
      interval: null,
      intervalCount: null,
      quantity: 1,
      effectiveDate: at(-60),
    }),
    "plan change",
  );
  const handedOff = await prisma.subscription.findUniqueOrThrow({ where: { id: created1.subscriptionId }, select: { endedAt: true, canceledAt: true, status: true } });
  check("2. the old segment ended on T−60, not canceled", [handedOff.endedAt?.getTime(), handedOff.canceledAt, handedOff.status], [at(-60).getTime(), null, "CANCELED"]);
  live = await liveFigures(orgId);
  check("2. live MRR 300.00 (expansion, same customer)", [live.mrr, live.customers], [30_000, 1]);
  check("2. snapshot T−61: still 100.00", (await storedRow(orgId, -61))?.mrrCents, 10_000);
  check("2. snapshot T−60: 300.00, no new or churned customer", pick(await storedRow(orgId, -60), "mrrCents", "newCustomers", "churnedCustomers", "churnedSubs"), [30_000, 0, 0, 0]);
  rebuild = await matchesFullRebuild(orgId, -90);
  check("2. recompute from T−60 leaves every row = full rebuild", rebuild.mismatches, []);

  // ---- 3. quantity change -------------------------------------------------------
  const change3 = await afterWrite(
    orgId,
    await changeSubscriptionOp(orgId, "USD", {
      subscriptionId: change2.subscriptionId,
      planId: pro.id,
      price: null,
      interval: null,
      intervalCount: null,
      quantity: 3,
      effectiveDate: at(-30),
    }),
    "quantity change",
  );
  live = await liveFigures(orgId);
  check("3. live MRR 900.00 (Pro × 3)", live.mrr, 90_000);
  check("3. snapshot T−31 / T−30: 300.00 → 900.00", [(await storedRow(orgId, -31))?.mrrCents, (await storedRow(orgId, -30))?.mrrCents], [30_000, 90_000]);

  // ---- 4. a second customer, canceled in the past -------------------------------
  const bravo = await afterWrite(
    orgId,
    await createSubscriptionOp(orgId, "USD", {
      customerId: NEW_CUSTOMER,
      newCustomerName: "Bravo",
      planId: basic.id,
      price: null,
      interval: null,
      intervalCount: null,
      quantity: 2,
      status: "ACTIVE",
      startDate: at(-50),
      recordPastInvoices: false,
    }),
    "Bravo's subscription",
  );
  check("4. Bravo created inline with no invoices", [bravo.invoices, await prisma.customer.count({ where: { organizationId: orgId } })], [0, 2]);
  await afterWrite(orgId, await cancelSubscriptionOp(orgId, { subscriptionId: bravo.subscriptionId, effectiveDate: at(-20) }), "past cancellation");
  const bravoRow = await prisma.subscription.findUniqueOrThrow({ where: { id: bravo.subscriptionId }, select: { endedAt: true, canceledAt: true, status: true } });
  check("4. past cancel: endedAt = canceledAt = T−20, CANCELED", [bravoRow.endedAt?.getTime(), bravoRow.canceledAt?.getTime(), bravoRow.status], [at(-20).getTime(), at(-20).getTime(), "CANCELED"]);
  live = await liveFigures(orgId);
  check("4. live: MRR 900.00, 1 active customer", [live.mrr, live.customers], [90_000, 1]);
  check("4. snapshot T−21: 1,100.00 and 2 customers", pick(await storedRow(orgId, -21), "mrrCents", "activeCustomers"), [110_000, 2]);
  check("4. snapshot T−20: Bravo churned", pick(await storedRow(orgId, -20), "mrrCents", "activeCustomers", "churnedCustomers", "churnedSubs"), [90_000, 1, 1, 1]);
  const window = await getMetricsSummary(orgId, { kind: "range", start: at(-25), end: at(-15) });
  check("4. customer churn over (T−25, T−15] = 1 of 2; revenue churn = 200 / 1,100", [window.customerChurnRate.current, window.revenueChurnRate.current], [0.5, 20_000 / 110_000]);
  const cancelAgain = await cancelSubscriptionOp(orgId, { subscriptionId: bravo.subscriptionId, effectiveDate: T });
  check("4. canceling an ended subscription is refused", cancelAgain.ok, false);

  // ---- 5. a future cancellation, then undone -----------------------------------
  const before5 = await matchesFullRebuild(orgId, -90);
  await afterWrite(orgId, await cancelSubscriptionOp(orgId, { subscriptionId: change3.subscriptionId, effectiveDate: at(30) }), "future cancellation");
  const scheduled = await prisma.subscription.findUniqueOrThrow({ where: { id: change3.subscriptionId }, select: { endedAt: true, canceledAt: true, status: true } });
  check("5. scheduled: endedAt T+30, canceledAt set (now), status unchanged", [scheduled.endedAt?.getTime(), scheduled.canceledAt !== null, scheduled.status], [at(30).getTime(), true, "ACTIVE"]);
  live = await liveFigures(orgId);
  check("5. still billing until then: MRR 900.00, 1 customer", [live.mrr, live.customers], [90_000, 1]);
  const doubleSchedule = await cancelSubscriptionOp(orgId, { subscriptionId: change3.subscriptionId, effectiveDate: at(10) });
  check("5. a second cancellation while one is scheduled is refused", doubleSchedule.ok, false);
  const changeWhileScheduled = await changeSubscriptionOp(orgId, "USD", {
    subscriptionId: change3.subscriptionId, planId: basic.id, price: null, interval: null, intervalCount: null, quantity: 1, effectiveDate: T,
  });
  check("5. a plan change while a cancellation is scheduled is refused", changeWhileScheduled.ok, false);
  const after5 = await matchesFullRebuild(orgId, -90);
  check("5. no past snapshot moved", [after5.mismatches, after5.days], [before5.mismatches, before5.days]);
  await afterWrite(orgId, await undoScheduledCancelOp(orgId, change3.subscriptionId), "undo scheduled cancel");
  const undone = await prisma.subscription.findUniqueOrThrow({ where: { id: change3.subscriptionId }, select: { endedAt: true, canceledAt: true } });
  check("5. undo clears both dates", [undone.endedAt, undone.canceledAt], [null, null]);

  // ---- 6. corrected start date ----------------------------------------------------
  await afterWrite(
    orgId,
    await correctSubscriptionOp(orgId, "USD", {
      subscriptionId: change3.subscriptionId,
      startDate: at(-40),
      price: 30_000,
      quantity: 3,
      status: "ACTIVE",
    }),
    "correct start date",
  );
  const [pro1, pro3] = await Promise.all([
    prisma.subscription.findUniqueOrThrow({ where: { id: change2.subscriptionId }, select: { endedAt: true } }),
    prisma.subscription.findUniqueOrThrow({ where: { id: change3.subscriptionId }, select: { startedAt: true } }),
  ]);
  check("6. the hand-off moved with it: Pro × 1 ends T−40, Pro × 3 starts T−40", [pro1.endedAt?.getTime(), pro3.startedAt.getTime()], [at(-40).getTime(), at(-40).getTime()]);
  check(
    "6. snapshots T−41 / T−40 / T−35: 300 → 900 (+200 Bravo) — history rewritten",
    [(await storedRow(orgId, -41))?.mrrCents, (await storedRow(orgId, -40))?.mrrCents, (await storedRow(orgId, -35))?.mrrCents],
    [30_000 + 20_000, 90_000 + 20_000, 90_000 + 20_000],
  );
  const beforeStart = await correctSubscriptionOp(orgId, "USD", { subscriptionId: change3.subscriptionId, startDate: at(-60), price: 30_000, quantity: 3, status: "ACTIVE" });
  check("6. a corrected start at or before the previous terms' start is refused", beforeStart.ok ? "accepted" : Object.keys(beforeStart.fieldErrors), ["startDate"]);
  rebuild = await matchesFullRebuild(orgId, -90);
  check("6. after every step, stored rows = full rebuild (91 days)", [rebuild.days, rebuild.mismatches], [91, []]);

  // ---- recompute from an arbitrary X equals the full rebuild -------------------------
  await prisma.metricSnapshot.updateMany({ where: { organizationId: orgId, date: { gte: at(-45) } }, data: { mrrCents: 1 } });
  await recomputeSnapshots(orgId, at(-45));
  rebuild = await matchesFullRebuild(orgId, -90);
  check("recompute from X = T−45 (rows after X corrupted first) = full rebuild", rebuild.mismatches, []);
  const untouched = await storedRow(orgId, -46);
  check("… and it did not rewrite days before X", untouched?.mrrCents, 30_000 + 20_000);

  // ---- tenant isolation and status consistency -------------------------------------
  const foreign = await changeSubscriptionOp(other.id, "USD", {
    subscriptionId: change3.subscriptionId, planId: CUSTOM_PRICE, price: 1, interval: "MONTH", intervalCount: 1, quantity: 1, effectiveDate: T,
  });
  check("another workspace's subscription id is refused as stale", foreign.ok ? "accepted" : foreign.message, "This page is out of date. Reload it and try again.");
  const foreignPlan = await createSubscriptionOp(other.id, "USD", {
    customerId: alpha.id, newCustomerName: "", planId: pro.id, price: null, interval: null, intervalCount: null, quantity: 1, status: "ACTIVE", startDate: T, recordPastInvoices: false,
  });
  check("another workspace's customer id is refused", foreignPlan.ok ? "accepted" : Object.keys(foreignPlan.fieldErrors), ["customerId"]);
  const contradictions = await prisma.subscription.count({
    where: { organizationId: orgId, endedAt: { lte: new Date() }, status: { not: "CANCELED" } },
  });
  check("no segment's status contradicts its dates", contradictions, 0);

  return created;
}

function pick(row: SnapshotMetrics | null, ...keys: (keyof SnapshotMetrics)[]): (number | null)[] {
  return keys.map((key) => (row === null ? null : row[key]));
}
