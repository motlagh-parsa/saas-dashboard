import type { PlanTier } from "@prisma/client";
import {
  CalendarRange,
  ChartSpline,
  Layers,
  TriangleAlert,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";

import type {
  ActiveSubscriptionsResult,
  MRRTrendPoint,
  MetricsSummary,
  NetRevenueRetentionResult,
  RecentInvoice,
  UserActivitySummary,
} from "@/lib/metrics";
import {
  EM_DASH,
  formatCount,
  formatDay,
  formatEnumLabel,
  formatMonthLong,
  formatMonthShort,
  formatMoney,
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
import { TierMixChart, type TierDatum } from "@/components/dashboard/tier-mix-chart";

/**
 * The overview's data-owning sections.
 *
 * Each one awaits only the queries it renders, so the page can hand every
 * section its own `<Suspense>` boundary and stream them independently instead of
 * blocking the whole route on the slowest statement. The promises are started by
 * the page, in parallel, before any of these are reached.
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
  const { currency, isMixedCurrency, mrrCents } = summary;

  const points: MRRTrendDatum[] = trend.map((point) => ({
    month: point.month,
    tick: formatMonthShort(point.month),
    heading: formatMonthLong(point.month),
    mrrCents: point.mrrCents,
    activeSubs: point.activeSubs,
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

          {isMixedCurrency ? (
            <p className="mt-3 flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground text-balance">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
              <span>
                Subscriptions bill in more than one currency and no exchange rates
                are stored, so this figure adds unlike amounts. Read it as an
                approximation until rates are configured.
              </span>
            </p>
          ) : null}
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
  const { arrCents, activeSubscriptions, churnRate, currency } = summary;

  const subscriberDelta = activeSubscriptions.current - activeSubscriptions.previous;

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
        label="Active subscriptions"
        icon={Users}
        delta={
          <DeltaBadge
            value={activeSubscriptions.changePct}
            unit="percent"
            goodDirection="up"
          />
        }
        footnote={`${formatSignedCount(subscriberDelta)} vs ${comparison}`}
      >
        <CountUp value={activeSubscriptions.current} format="count" />
      </MetricTile>

      <MetricTile
        label="Churn rate"
        icon={UserMinus}
        delta={
          // Points, not percent: a percent change of a percentage reads a one
          // point move as a catastrophe. Up is bad here, so the colour flips.
          <DeltaBadge value={churnRate.changePoints} unit="points" goodDirection="down" />
        }
        footnote={
          churnRate.current === null
            ? "No subscriptions were live at period start"
            : `Cancelled in the last ${comparison.replace("previous ", "")}`
        }
      >
        {churnRate.current === null ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          <CountUp value={churnRate.current} format="percent" digits={1} />
        )}
      </MetricTile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User activity
// ---------------------------------------------------------------------------

interface UserActivityStripProps {
  activityPromise: Promise<UserActivitySummary>;
  /** "previous 30 days" etc. — the same phrase the KPI strip uses. */
  comparison: string;
}

/**
 * Active and new users, from MetricSnapshot, with the same period comparison as
 * the KPI strip above it.
 *
 * The footnotes say "seats" on purpose: the snapshot's user figures are an
 * estimate from plan seat counts, not logins, and the tile must not pass one off
 * as the other. The as-of date is named because snapshots only exist up to the
 * last day the daily job ran, and a stale count otherwise looks current.
 */
export async function UserActivityStrip({ activityPromise, comparison }: UserActivityStripProps) {
  const { activeUsers, newUsers, asOfDate } = await activityPromise;
  const span = comparison.replace("previous ", "");

  const seatDelta =
    activeUsers.current === null || activeUsers.previous === null
      ? null
      : activeUsers.current - activeUsers.previous;
  const asOf = asOfDate === null ? null : formatDay(new Date(`${asOfDate}T00:00:00Z`));

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <MetricTile
        label="Active users"
        icon={UserCheck}
        delta={<DeltaBadge value={activeUsers.changePct} unit="percent" goodDirection="up" />}
        footnote={
          asOf === null
            ? "No user snapshot recorded yet"
            : seatDelta === null
              ? `Estimated seats on live plans, as of ${asOf}`
              : `${formatSignedCount(seatDelta)} vs ${comparison} · seats as of ${asOf}`
        }
      >
        {activeUsers.current === null ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          <CountUp value={activeUsers.current} format="count" />
        )}
      </MetricTile>

      <MetricTile
        label="New users"
        icon={UserPlus}
        delta={<DeltaBadge value={newUsers.changePct} unit="percent" goodDirection="up" />}
        footnote={`Net seats added in the last ${span}`}
      >
        <CountUp value={newUsers.current} format="count" />
      </MetricTile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan mix
// ---------------------------------------------------------------------------

/**
 * Tier rank, top to bottom. Fixed order and fixed colour binding: the ramp step
 * follows the TIER, never its count, so filtering or a change in mix can never
 * repaint a surviving row.
 */
const TIER_ORDER: readonly PlanTier[] = ["ENTERPRISE", "PRO", "STARTER", "FREE"];

const TIER_FILL: Record<PlanTier, string> = {
  ENTERPRISE: "var(--tier-4)",
  PRO: "var(--tier-3)",
  STARTER: "var(--tier-2)",
  FREE: "var(--tier-1)",
};

interface PlanMixPanelProps {
  subscriptionsPromise: Promise<ActiveSubscriptionsResult>;
}

export async function PlanMixPanel({ subscriptionsPromise }: PlanMixPanelProps) {
  const result = await subscriptionsPromise;
  const counts = new Map(result.byTier.map((entry) => [entry.tier, entry.count]));

  // Every tier is rendered, including the ones at zero — "no enterprise
  // customers" is information, and dropping the row would hide it.
  const data: TierDatum[] = TIER_ORDER.map((tier) => {
    const count = counts.get(tier) ?? 0;
    return {
      tier,
      label: formatEnumLabel(tier),
      count,
      share: result.total === 0 ? 0 : count / result.total,
      fill: TIER_FILL[tier],
    };
  });

  const pastDue = result.byStatus.find((entry) => entry.status === "PAST_DUE")?.count ?? 0;

  return (
    <Card className="h-full">
      <CardHeader>
        <h2 className={EYEBROW}>Subscriptions by plan</h2>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(result.total)} live
          </span>
        </CardAction>
      </CardHeader>

      {result.total === 0 ? (
        <CardContent>
          <EmptyState
            icon={Layers}
            title="No live subscriptions"
            description="The plan mix fills in as customers subscribe. Free trials count from the day they start."
            className="border-0 bg-transparent py-8"
          />
        </CardContent>
      ) : (
        <>
          <CardContent>
            <TierMixChart data={data} />
          </CardContent>
          <CardContent className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3">
            <p className="text-[0.6875rem] text-muted-foreground">
              Live subscriptions today, ordered by plan
            </p>
            {pastDue > 0 ? (
              <p className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-negative" />
                {formatCount(pastDue)} past due
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
}

export async function InvoicesPanel({ invoicesPromise }: InvoicesPanelProps) {
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
      <InvoiceTable invoices={invoices} />
    </Card>
  );
}
