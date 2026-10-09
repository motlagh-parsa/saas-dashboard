import "server-only";

// The alert engine: looks at a workspace's billing data and raises the
// notifications a founder would want to hear about, each exactly once.
//
// Runs after every snapshot recompute (lib/snapshots.ts), after imports and
// sample data, and from the daily job. Every check is idempotent: what has been
// said is recorded as an AlertMark (one row per churned customer, overdue
// invoice, milestone, dip week), and only things without a mark are new.
//
// Noise is bounded on purpose: each check raises AT MOST ONE notification per
// run, naming the biggest item and counting the rest. A first import with forty
// overdue invoices produces one "40 invoices are overdue", not forty rows.
//
//   - MRR milestone:  today's MRR has reached a round number for the first time.
//   - Revenue dip:    MRR is down more than 5% on seven days ago (once per week).
//   - Customer churn: a customer worth at least 2% of MRR stopped paying in the
//                     last two days.
//   - Overdue:        an OPEN invoice is past its due date, or an invoice was
//                     marked UNCOLLECTIBLE.
//
// A workspace holding sample data gets its alerts in the app only — never by
// email: nobody should be emailed about invented customers.
import type { NotificationType } from "@prisma/client";

import { formatMoney, formatPercent } from "@/lib/format";
import { getCustomerList } from "@/lib/metrics";
import { createNotification, type NewNotification } from "@/lib/notification-writer";
import { prisma } from "@/lib/prisma";
import { DAY_MS, utcDayStart } from "@/lib/snapshot-formula";

/** Round MRR numbers worth a notification, in major units. */
const MILESTONES_MAJOR = [
  1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
];

export const CHURN_SHARE_THRESHOLD = 0.02;
export const DIP_THRESHOLD = 0.05;
const CHURN_WINDOW_MS = 2 * DAY_MS;

export interface AlertRunResult {
  readonly raised: readonly NotificationType[];
}

/** Keys from `candidates` that have no mark yet; marks them in the same call. */
async function claimNew(organizationId: string, candidates: readonly string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const existing = await prisma.alertMark.findMany({
    where: { organizationId, key: { in: [...candidates] } },
    select: { key: true },
  });
  const seen = new Set(existing.map((row) => row.key));
  const fresh = candidates.filter((key) => !seen.has(key));
  if (fresh.length > 0) {
    // skipDuplicates: two runs racing for the same key both insert; one wins,
    // and only the keys THIS call inserted are treated as new.
    await prisma.alertMark.createMany({
      data: fresh.map((key) => ({ organizationId, key })),
      skipDuplicates: true,
    });
  }
  return new Set(fresh);
}

function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function andMore(count: number, noun: string): string {
  return count > 0 ? ` and ${count} more ${noun}${count === 1 ? "" : "s"}` : "";
}

type Emit = (notification: NewNotification) => Promise<void>;

async function checkMilestone(organizationId: string, currency: string, today: Date, emit: Emit): Promise<boolean> {
  const snapshot = await prisma.metricSnapshot.findFirst({
    where: { organizationId, date: { lte: today } },
    orderBy: { date: "desc" },
    select: { mrrCents: true },
  });
  if (snapshot === null) return false;
  const reached = MILESTONES_MAJOR.filter((major) => snapshot.mrrCents >= major * 100);
  if (reached.length === 0) return false;
  // Every milestone already passed is marked, but only the highest is said:
  // a workspace imported at $40k MRR hears "$25k", not five notifications.
  const fresh = await claimNew(
    organizationId,
    reached.map((major) => `mrr-milestone:${major}`),
  );
  const top = reached[reached.length - 1];
  if (!fresh.has(`mrr-milestone:${top}`)) return false;
  await emit({
    organizationId,
    type: "MRR_MILESTONE",
    title: `MRR passed ${formatMoney(top * 100, currency)}`,
    body: `Monthly recurring revenue is now ${formatMoney(snapshot.mrrCents, currency)}.`,
  });
  return true;
}

async function checkDip(organizationId: string, currency: string, today: Date, emit: Emit): Promise<boolean> {
  const [now, before] = await Promise.all([
    prisma.metricSnapshot.findUnique({ where: { organizationId_date: { organizationId, date: today } }, select: { mrrCents: true } }),
    prisma.metricSnapshot.findUnique({
      where: { organizationId_date: { organizationId, date: new Date(today.getTime() - 7 * DAY_MS) } },
      select: { mrrCents: true },
    }),
  ]);
  if (now === null || before === null || before.mrrCents <= 0) return false;
  const change = (now.mrrCents - before.mrrCents) / before.mrrCents;
  if (change > -DIP_THRESHOLD) return false;
  const fresh = await claimNew(organizationId, [`revenue-dip:${isoWeek(today)}`]);
  if (fresh.size === 0) return false;
  await emit({
    organizationId,
    type: "REVENUE_DIP",
    title: `MRR down ${formatPercent(-change)} this week`,
    body: `MRR fell from ${formatMoney(before.mrrCents, currency)} to ${formatMoney(now.mrrCents, currency)} over the last seven days.`,
  });
  return true;
}

async function checkChurn(organizationId: string, currency: string, now: Date, emit: Emit): Promise<boolean> {
  const windowStart = new Date(now.getTime() - CHURN_WINDOW_MS);
  const [then, current] = await Promise.all([getCustomerList(organizationId, windowStart), getCustomerList(organizationId, now)]);
  const mrrThen = then.customers.reduce((sum, row) => sum + row.mrrCents, 0);
  if (mrrThen <= 0) return false;
  const stillActive = new Set(current.customers.filter((row) => row.state === "active").map((row) => row.id));
  const endedAt = new Map(current.customers.map((row) => [row.id, row.churnedAt]));

  const churned = then.customers
    .filter((row) => row.state === "active" && !stillActive.has(row.id))
    .filter((row) => row.mrrCents >= mrrThen * CHURN_SHARE_THRESHOLD)
    .sort((a, b) => b.mrrCents - a.mrrCents);
  if (churned.length === 0) return false;

  const keyOf = (id: string): string => `churn:${id}:${endedAt.get(id)?.toISOString().slice(0, 10) ?? "unknown"}`;
  const fresh = await claimNew(organizationId, churned.map((row) => keyOf(row.id)));
  const newlyChurned = churned.filter((row) => fresh.has(keyOf(row.id)));
  if (newlyChurned.length === 0) return false;

  const lost = newlyChurned.reduce((sum, row) => sum + row.mrrCents, 0);
  const [first] = newlyChurned;
  await emit({
    organizationId,
    type: "CHURN_ALERT",
    title:
      newlyChurned.length === 1
        ? `${first.name} churned`
        : `${newlyChurned.length} customers churned`,
    body: `${first.name}${andMore(newlyChurned.length - 1, "customer")} stopped paying — ${formatMoney(lost, currency)} of MRR (${formatPercent(lost / mrrThen)}).`,
  });
  return true;
}

async function checkInvoices(organizationId: string, currency: string, today: Date, emit: Emit): Promise<boolean> {
  const problems = await prisma.invoice.findMany({
    where: {
      organizationId,
      OR: [{ status: "OPEN", dueAt: { lt: today } }, { status: "UNCOLLECTIBLE" }],
    },
    orderBy: { amountCents: "desc" },
    select: { id: true, status: true, amountCents: true, customer: { select: { name: true } } },
    take: 1000,
  });
  if (problems.length === 0) return false;
  const keyOf = (row: (typeof problems)[number]): string => `${row.status === "OPEN" ? "overdue" : "uncollectible"}:${row.id}`;
  const fresh = await claimNew(organizationId, problems.map(keyOf));
  const newProblems = problems.filter((row) => fresh.has(keyOf(row)));
  if (newProblems.length === 0) return false;

  const total = newProblems.reduce((sum, row) => sum + row.amountCents, 0);
  const overdue = newProblems.filter((row) => row.status === "OPEN").length;
  const uncollectible = newProblems.length - overdue;
  const [first] = newProblems;
  const parts = [
    overdue > 0 ? `${overdue} overdue` : null,
    uncollectible > 0 ? `${uncollectible} uncollectible` : null,
  ].filter((part): part is string => part !== null);
  await emit({
    organizationId,
    type: "INVOICE_OVERDUE",
    title:
      newProblems.length === 1
        ? `${first.customer.name}: invoice ${first.status === "OPEN" ? "overdue" : "uncollectible"}`
        : `${newProblems.length} invoices need attention`,
    body: `${parts.join(" and ")} — ${formatMoney(total, currency)} in total. The largest is ${formatMoney(first.amountCents, currency)} from ${first.customer.name}.`,
  });
  return true;
}

/**
 * Runs every check for one workspace. Never throws: an alert that fails to be
 * raised is logged, and the billing write or job that triggered it carries on.
 */
export async function evaluateAlerts(organizationId: string, now: Date = new Date()): Promise<AlertRunResult> {
  const raised: NotificationType[] = [];
  try {
    const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
    if (organization === null) return { raised };
    const { currency } = organization;
    const today = utcDayStart(now);
    const hasSample = (await prisma.customer.count({ where: { organizationId, source: "SAMPLE" } })) > 0;
    const emit: Emit = (notification) => createNotification(notification, { email: !hasSample });
    const checks: ReadonlyArray<[NotificationType, () => Promise<boolean>]> = [
      ["CHURN_ALERT", () => checkChurn(organizationId, currency, now, emit)],
      ["REVENUE_DIP", () => checkDip(organizationId, currency, today, emit)],
      ["INVOICE_OVERDUE", () => checkInvoices(organizationId, currency, today, emit)],
      ["MRR_MILESTONE", () => checkMilestone(organizationId, currency, today, emit)],
    ];
    for (const [type, check] of checks) {
      try {
        if (await check()) raised.push(type);
      } catch (error: unknown) {
        console.error("[alerts] check failed", { organizationId, type, error });
      }
    }
  } catch (error: unknown) {
    console.error("[alerts] evaluation failed", { organizationId, error });
  }
  return { raised };
}

/**
 * The Monday summary of the week that just ended: MRR now against seven days
 * ago, and new / churned customers over those seven days — straight from the
 * snapshots, so it agrees with the charts. Once per ISO week per workspace;
 * in-app only while the workspace holds sample data, like every alert.
 */
export async function sendWeeklySummary(organizationId: string, now: Date = new Date()): Promise<boolean> {
  const today = utcDayStart(now);
  const weekAgo = new Date(today.getTime() - 7 * DAY_MS);
  const [organization, latest, previous, week] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } }),
    prisma.metricSnapshot.findUnique({ where: { organizationId_date: { organizationId, date: today } }, select: { mrrCents: true } }),
    prisma.metricSnapshot.findUnique({ where: { organizationId_date: { organizationId, date: weekAgo } }, select: { mrrCents: true } }),
    prisma.metricSnapshot.aggregate({
      where: { organizationId, date: { gt: weekAgo, lte: today } },
      _sum: { newCustomers: true, churnedCustomers: true },
    }),
  ]);
  if (organization === null || latest === null) return false;
  const fresh = await claimNew(organizationId, [`weekly-summary:${isoWeek(weekAgo)}`]);
  if (fresh.size === 0) return false;

  const { currency } = organization;
  const change =
    previous !== null && previous.mrrCents > 0 ? (latest.mrrCents - previous.mrrCents) / previous.mrrCents : null;
  const changeText =
    change === null ? "" : ` (${change >= 0 ? "up" : "down"} ${formatPercent(Math.abs(change))} on last week)`;
  const added = week._sum.newCustomers ?? 0;
  const lost = week._sum.churnedCustomers ?? 0;
  const hasSample = (await prisma.customer.count({ where: { organizationId, source: "SAMPLE" } })) > 0;

  await createNotification(
    {
      organizationId,
      type: "WEEKLY_SUMMARY",
      title: `Your week: MRR ${formatMoney(latest.mrrCents, currency)}`,
      body: `MRR is ${formatMoney(latest.mrrCents, currency)}${changeText}. ${added} new ${added === 1 ? "customer" : "customers"}, ${lost} churned.`,
    },
    { email: !hasSample },
  );
  return true;
}
