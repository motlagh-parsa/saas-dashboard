import "server-only";

// /v1/metrics — the Overview's numbers, read with the Overview's functions.
//
// summary?date=D: the figures as of D. For today that is "now", exactly the
// instant the Overview anchors on; for a past day it is the last instant of
// that day. Flows and rates cover the 30 days up to it — the Overview's default
// window (lib/period.ts, `last_30_days`).
import { dateToDay, dayToDate, todayUtc } from "@/lib/billing-form";
import {
  getCustomerActivity,
  getCustomerList,
  getMetricsSummary,
  getNetRevenueRetention,
  getReactivatedCustomers,
  type Period,
} from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { DAY_MS } from "@/lib/snapshot-formula";

import type { ApiWriteContext } from "../context";
import { invalid } from "../errors";
import { dayParam } from "../schema";

export const SUMMARY_WINDOW_DAYS = 30;
export const MAX_SERIES_DAYS = 730;

export interface MetricsSummaryWire {
  readonly object: "metrics_summary";
  readonly date: string;
  /** The instant the state figures are measured at. */
  readonly as_of: string;
  /** The window the flows and rates cover: (start, end]. */
  readonly period: { readonly start: string; readonly end: string };
  readonly currency: string;
  readonly mrr: number;
  readonly arr: number;
  readonly active_customers: number;
  readonly new_customers: number;
  readonly churned_customers: number;
  readonly reactivated_customers: number;
  /** Fractions (0.05 = 5%); null when there was no one to churn or retain. */
  readonly customer_churn_rate: number | null;
  readonly revenue_churn_rate: number | null;
  readonly nrr: number | null;
  readonly grr: number | null;
  readonly arpa: number;
}

/** The instant a `date` means: now for today, the day's last millisecond before. */
export function summaryInstant(day: Date | null, now: Date): Date {
  if (day === null || dateToDay(day) === todayUtc(now)) return now;
  return new Date(day.getTime() + DAY_MS - 1);
}

export async function getSummary(ctx: ApiWriteContext, query: URLSearchParams): Promise<MetricsSummaryWire> {
  const day = dayParam(query, "date");
  if (day !== null && dateToDay(day) > todayUtc(ctx.now)) throw invalid("date: Use today or an earlier date.", "date");
  const asOf = summaryInstant(day, ctx.now);
  const period: Period = { kind: "range", start: new Date(asOf.getTime() - SUMMARY_WINDOW_DAYS * DAY_MS), end: asOf };

  const [summary, retention, activity, reactivated, customers] = await Promise.all([
    getMetricsSummary(ctx.organizationId, period),
    getNetRevenueRetention(ctx.organizationId, period),
    getCustomerActivity(ctx.organizationId, period),
    getReactivatedCustomers(ctx.organizationId, period),
    getCustomerList(ctx.organizationId, asOf),
  ]);
  const starting = retention.startingMRRCents;
  return {
    object: "metrics_summary",
    date: dateToDay(asOf),
    as_of: asOf.toISOString(),
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    currency: summary.currency,
    mrr: summary.mrrCents.current,
    arr: summary.arrCents.current,
    active_customers: summary.activeCustomers.current,
    new_customers: activity.newCustomers.current,
    churned_customers: activity.churnedCustomers.current,
    reactivated_customers: reactivated,
    customer_churn_rate: summary.customerChurnRate.current,
    revenue_churn_rate: summary.revenueChurnRate.current,
    nrr: retention.nrr,
    // Gross retention: NRR without expansion — what the cohort kept, capped at 100%.
    grr: starting === 0 ? null : (starting - retention.contractionMRRCents - retention.churnedMRRCents) / starting,
    arpa: customers.averageMRRCents,
  };
}

export interface MrrPointWire {
  readonly date: string;
  readonly mrr: number;
  readonly arr: number;
  readonly active_customers: number;
  readonly new_customers: number;
  readonly churned_customers: number;
}

export async function getMrrSeries(
  ctx: ApiWriteContext,
  query: URLSearchParams,
): Promise<{ object: "list"; currency: string; from: string; to: string; data: MrrPointWire[] }> {
  const today = dayToDate(todayUtc(ctx.now));
  const to = dayParam(query, "to") ?? today;
  const from = dayParam(query, "from") ?? new Date(to.getTime() - 29 * DAY_MS);
  if (from > to) throw invalid("from: Use a date on or before `to`.", "from");
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_SERIES_DAYS) throw invalid(`to: A series spans at most ${MAX_SERIES_DAYS} days.`, "to");

  const rows = await prisma.metricSnapshot.findMany({
    where: { organizationId: ctx.organizationId, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
    select: { date: true, mrrCents: true, activeCustomers: true, newCustomers: true, churnedCustomers: true },
  });
  return {
    object: "list",
    currency: ctx.currency,
    from: dateToDay(from),
    to: dateToDay(to),
    data: rows.map((row) => ({
      date: dateToDay(row.date),
      mrr: row.mrrCents,
      arr: row.mrrCents * 12,
      active_customers: row.activeCustomers,
      new_customers: row.newCustomers,
      churned_customers: row.churnedCustomers,
    })),
  };
}
