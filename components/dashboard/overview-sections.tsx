import {
  CalendarRange,
  ChartSpline,
  Layers,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";

import type {
  CustomerActivitySummary,
  MRRTrendPoint,
  MetricsSummary,
  NetRevenueRetentionResult,
  PlanMixResult,
  RecentInvoice,
} from "@/lib/metrics";
import {
  EM_DASH,
  formatCount,
  formatDay,
  formatMonthLong,
  formatMonthShort,
  formatMoney,
  formatPercent,
  formatSignedCount,
} from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { CountUp } from "@/components/dashboard/count-up";
import { DeltaBadge } from "@/components/dashboard/delta-badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InvoiceTable } from "@/components/dashboard/invoice-table";
import { MetricTile } from "@/components/dashboard/metric-tile";
import { MRRTrendChart, type MRRTrendDatum } from "@/components/dashboard/mrr-trend-chart";
import { NRRLedger } from "@/components/dashboard/nrr-ledger";
import { PlanMixChart, type PlanMixDatum } from "@/components/dashboard/plan-mix-chart";

/**
 * The overview's data-owning sections.
 *
 * Each one awaits only the queries it renders, so the page can hand every
 * section its own `<Suspense>` boundary and stream them independently instead of
 * blocking the whole route on the slowest statement. The promises are started by
 * the page, in parallel, before any of these are reached.
 *
 * Every amount is in the workspace's single currency (`summary.currency`).
 */

/** Eyebrow used on every panel — small mono caps, the label voice of the page. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

// ---------------------------------------------------------------------------
// Headline: MRR + the trend that produced it
// ---------------------------------------------------------------------------

interface HeadlinePanelProps {
  summaryPromise: Promise<MetricsSummary>;
  trendPromise: Promise<MRRTrendPoint[]>;
  /** Tail of "vs …", e.g. "previous 30 days". */
  comparison: string;
}

export async function HeadlinePanel({
  summaryPromise,
  trendPromise,
  comparison,
}: HeadlinePanelProps) {
  const [summary, trend] = await Promise.all([summaryPromise, trendPromise]);
  const { currency, mrrCents } = summary;

  const points: MRRTrendDatum[] = trend.map((point) => ({
    month: point.month,
    tick: formatMonthShort(point.month),
    heading: formatMonthLong(point.month),
    mrrCents: point.mrrCents,
    activeCustomers: point.activeCustomers,
  }));

  const hasHistory = points.length > 0;
  // A workspace with no revenue AND no snapshots has never billed anyone. One
  // with $0 today but months behind it is a different, and much worse, story —
  // that one still gets the figure and the chart.
  const isFirstRun = mrrCents.current === 0 && mrrCents.previous === 0 && !hasHistory;

  return (
    <Card className="h-full gap-5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-brand" />
          <h2 className={EYEBROW}>Monthly recurring revenue</h2>
        </div>
        {isFirstRun ? null : (
          <CardAction>
            <DeltaBadge value={mrrCents.changePct} unit="percent" goodDirection="up" />
          </CardAction>
        )}
      </CardHeader>

      {isFirstRun ? (
        <CardContent>
          <EmptyState
            icon={ChartSpline}
            title="No recurring revenue yet"
            description="Your MRR appears here as soon as the first paid subscription starts billing."
            className="border-0 bg-transparent py-8"
          />
        </CardContent>
      ) : (
        <CardContent>
          <CountUp
            value={mrrCents.current}
            format="money"
            currency={currency}
            className="font-mono text-[2.5rem] leading-none tracking-[-0.035em] text-foreground tabular-nums sm:text-5xl"
          />
          {/* The brass rule sits under the one number this page exists to report. */}
          <span aria-hidden className="mt-3.5 block h-px w-14 bg-brand" />
          <p className="mt-3 text-[0.8125rem] text-muted-foreground">
            {formatMoney(mrrCents.previous, currency)} in the {comparison}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            <span className="font-mono">{currency}</span>
          </p>
        </CardContent>
      )}

      {hasHistory ? (
        <CardContent>
          <MRRTrendChart data={points} currency={currency} />
          {/* Axis labelling lives here rather than inside the SVG: it reads at the
              body type size, and it does not steal plot area from the series. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3">
            <p className="text-[0.6875rem] text-muted-foreground">
              Month-end MRR, {points.length === 1 ? "one month" : `last ${points.length} months`}
            </p>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Vertical axis in {currency}
            </p>
          </div>
        </CardContent>
      ) : isFirstRun ? null : (
        <CardContent>
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            The trend fills in once daily snapshots have covered a full month.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

interface RetentionSectionProps {
  summaryPromise: Promise<MetricsSummary>;
  nrrPromise: Promise<NetRevenueRetentionResult>;
  comparison: string;
}

export async function RetentionSection({
  summaryPromise,
  nrrPromise,
  comparison,
}: RetentionSectionProps) {
  // Currency is settled by the summary query; retention reports cents only.
  const [summary, retention] = await Promise.all([summaryPromise, nrrPromise]);
  return (
    <NRRLedger result={retention} currency={summary.currency} comparison={comparison} />
  );
}

// ---------------------------------------------------------------------------
// Subordinate KPIs
// ---------------------------------------------------------------------------

interface KpiStripProps {
  summaryPromise: Promise<MetricsSummary>;
  comparison: string;
}

export async function KpiStrip({ summaryPromise, comparison }: KpiStripProps) {
  const summary = await summaryPromise;
  const { arrCents, activeCustomers, customerChurnRate, revenueChurnRate, currency } = summary;

  const customerDelta = activeCustomers.current - activeCustomers.previous;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <MetricTile
        label="Annual run rate"
        icon={CalendarRange}
        delta={<DeltaBadge value={arrCents.changePct} unit="percent" goodDirection="up" />}
        footnote="Monthly recurring revenue × 12"
      >
        <CountUp value={arrCents.current} format="money" currency={currency} />
      </MetricTile>

      <MetricTile
        label="Active customers"
        icon={Users}
        delta={
          <DeltaBadge value={activeCustomers.changePct} unit="percent" goodDirection="up" />
        }
        footnote={`${formatSignedCount(customerDelta)} vs ${comparison}`}
      >
        <CountUp value={activeCustomers.current} format="count" />
      </MetricTile>

      <MetricTile
        label="Customer churn"
        icon={UserMinus}
        delta={
          // Points, not percent: a percent change of a percentage reads a one
          // point move as a catastrophe. Up is bad here, so the colour flips.
          <DeltaBadge value={customerChurnRate.changePoints} unit="points" goodDirection="down" />
        }
        footnote={
          customerChurnRate.current === null
            ? "No customer was active at period start"
            : `Revenue churn ${formatPercent(revenueChurnRate.current, 1)} · last ${comparison.replace("previous ", "")}`
        }
      >
        {customerChurnRate.current === null ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          <CountUp value={customerChurnRate.current} format="percent" digits={1} />
        )}
      </MetricTile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

interface CustomerActivityStripProps {
  activityPromise: Promise<CustomerActivitySummary>;
  /** "previous 30 days" etc. — the same phrase the KPI strip uses. */
  comparison: string;
}

/**
 * Active, new and churned customers, from the daily snapshots, with the same
 * period comparison as the KPI strip above it. The as-of date is named because
 * snapshots only exist up to the last day the daily job ran, and a stale count
 * otherwise looks current.
 */
export async function CustomerActivityStrip({
  activityPromise,
  comparison,
}: CustomerActivityStripProps) {
  const { activeCustomers, newCustomers, churnedCustomers, asOfDate } = await activityPromise;
  const span = comparison.replace("previous ", "");
  const asOf = asOfDate === null ? null : formatDay(new Date(`${asOfDate}T00:00:00Z`));

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <MetricTile
        label="Customers"
        icon={UserCheck}
        delta={<DeltaBadge value={activeCustomers.changePct} unit="percent" goodDirection="up" />}
        footnote={asOf === null ? "No snapshot recorded yet" : `Paying customers as of ${asOf}`}
      >
        {activeCustomers.current === null ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          <CountUp value={activeCustomers.current} format="count" />
        )}
      </MetricTile>

      <MetricTile
        label="New customers"
        icon={UserPlus}
        delta={<DeltaBadge value={newCustomers.changePct} unit="percent" goodDirection="up" />}
        footnote={`First-time customers in the last ${span}`}
      >
        <CountUp value={newCustomers.current} format="count" />
      </MetricTile>

      <MetricTile
        label="Churned customers"
        icon={UserMinus}
        delta={
          <DeltaBadge value={churnedCustomers.changePct} unit="percent" goodDirection="down" />
        }
        footnote={`Stopped paying in the last ${span}`}
      >
        <CountUp value={churnedCustomers.current} format="count" />
      </MetricTile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan mix
// ---------------------------------------------------------------------------

interface PlanMixPanelProps {
  planMixPromise: Promise<PlanMixResult>;
  currency: string;
}

export async function PlanMixPanel({ planMixPromise, currency }: PlanMixPanelProps) {
  const result = await planMixPromise;

  const data: PlanMixDatum[] = result.byPlan.map((entry) => ({
    key: entry.planId ?? "custom",
    label: entry.name,
    mrrCents: entry.mrrCents,
    valueLabel: formatMoney(entry.mrrCents, currency),
    share: result.totalMRRCents === 0 ? 0 : entry.mrrCents / result.totalMRRCents,
    subscriptions: `${formatCount(entry.subscriptions)} ${
      entry.subscriptions === 1 ? "subscription" : "subscriptions"
    }`,
    isCustom: entry.planId === null,
  }));

  return (
    <Card className="h-full">
      <CardHeader>
        <h2 className={EYEBROW}>MRR by plan</h2>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(result.totalSubscriptions)} live
          </span>
        </CardAction>
      </CardHeader>

      {result.totalSubscriptions === 0 ? (
        <CardContent>
          <EmptyState
            icon={Layers}
            title="No live subscriptions"
            description="The plan mix fills in as customers subscribe."
            className="border-0 bg-transparent py-8"
          />
        </CardContent>
      ) : (
        <>
          <CardContent>
            <PlanMixChart data={data} />
          </CardContent>
          <CardContent className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3">
            <p className="text-[0.6875rem] text-muted-foreground">
              Live MRR today by plan, in {currency}. Custom = no plan, negotiated price.
            </p>
            {result.pastDueSubscriptions > 0 ? (
              <p className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-negative" />
                {formatCount(result.pastDueSubscriptions)} past due
              </p>
            ) : null}
          </CardContent>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

interface InvoicesPanelProps {
  invoicesPromise: Promise<RecentInvoice[]>;
  currency: string;
}

export async function InvoicesPanel({ invoicesPromise, currency }: InvoicesPanelProps) {
  const invoices = await invoicesPromise;

  return (
    <Card className="h-full gap-0 py-0">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5">
        <h2 className={EYEBROW}>Recent invoices</h2>
        {invoices.length > 0 ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            Last {formatCount(invoices.length)} issued
          </span>
        ) : null}
      </div>
      <InvoiceTable invoices={invoices} currency={currency} />
    </Card>
  );
}
