import { ArrowLeftRight, ChartSpline, Repeat, UserMinus } from "lucide-react";

import type {
  ChurnRateTrendPoint,
  MetricsSummary,
  NetRevenueRetentionResult,
  RevenueMovementPoint,
} from "@/lib/metrics";
import {
  EM_DASH,
  formatCount,
  formatMonthLong,
  formatMonthShort,
  formatMoney,
  formatMoneyMovement,
  formatPercent,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { CountUp } from "@/components/dashboard/count-up";
import { DeltaBadge } from "@/components/dashboard/delta-badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricTile } from "@/components/dashboard/metric-tile";
import {
  ChurnLineChart,
  type ChurnLineDatum,
} from "@/components/dashboard/churn-line-chart";
import { NrrLineChart, type NrrLineDatum } from "@/components/dashboard/nrr-line-chart";

/**
 * The retention page's data-owning sections.
 *
 * Each one awaits only the queries it renders, so the page can hand every section
 * its own `<Suspense>` boundary and stream them independently instead of blocking
 * the route on the slowest statement. The promises are started by the page, in
 * parallel, before any of these is reached.
 *
 * Everything a client chart receives has already been formatted here. Rates never
 * leave this file as raw fractions that need multiplying, money never leaves as
 * cents-plus-currency, months never leave as Dates, and no function is ever handed
 * across the boundary.
 *
 * The one exception is deliberate: a `null` rate stays `null` on its way into a
 * chart, because Recharts reads that as a GAP in the series, which is exactly what
 * "undefined for this month" looks like. Every rate that reaches TEXT is already an
 * em-dash by then.
 */

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

/** Footnote voice, shared by every panel footer on this page. */
const FOOTNOTE = "text-[0.6875rem] text-muted-foreground";

/**
 * What KIND of quantity a figure holds.
 *
 * Same tag as the revenue page's, and for the same reason: it stops someone
 * reading two figures on one screen as comparable when they are measured over
 * different windows or against different denominators.
 */
function ScopeTag({ children }: { children: string }) {
  return (
    <Badge
      variant="secondary"
      className="bg-muted font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase"
    >
      {children}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// The two headline rates
// ---------------------------------------------------------------------------

interface RetentionTilesProps {
  summaryPromise: Promise<MetricsSummary>;
  nrrPromise: Promise<NetRevenueRetentionResult>;
  /** Tail of "vs …", e.g. "previous 30 days". */
  comparison: string;
}

/**
 * NRR and churn, both scoped to the period control in the header.
 *
 * NRR is set larger and carries the brass rule, because it is the figure this
 * page exists to report. Two identically weighted tiles would say the two numbers
 * matter equally, and on a retention page they do not.
 */
export async function RetentionTiles({
  summaryPromise,
  nrrPromise,
  comparison,
}: RetentionTilesProps) {
  const [summary, retention] = await Promise.all([summaryPromise, nrrPromise]);
  const { churnRate } = summary;
  const { cohortSize, nrr } = retention;

  // "previous 30 days" -> "30 days", so it reads as a window rather than a
  // comparison when it follows "in the last".
  const windowLabel: string = comparison.replace("previous ", "");

  // The two tiles do NOT share a denominator, and that has to be said next to
  // them rather than in a footnote nobody reads. NRR follows paying segments
  // only; churn counts every live segment, free tiers included.
  const denominatorNote: string =
    cohortSize === 0
      ? `No paying subscription was live when this period opened, so retention has no cohort to follow yet. Churn is still measured over the same ${windowLabel}.`
      : `Retention follows the ${formatCount(cohortSize)} paying ${
          cohortSize === 1 ? "subscription" : "subscriptions"
        } that were live when the period opened. Churn counts every live subscription, free tiers included, so the two denominators differ on purpose.`;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile
          label="Net revenue retention"
          icon={Repeat}
          delta={<ScopeTag>Cohort</ScopeTag>}
          footnote="Revenue kept and grown from customers who were already paying, expansion included"
        >
          {nrr === null ? (
            <span className="text-[2rem] text-muted-foreground">{EM_DASH}</span>
          ) : (
            <CountUp value={nrr} format="percent" digits={1} className="text-[2rem]" />
          )}
          {/* The brass rule sits under the one number this page exists to report. */}
          <span aria-hidden className="mt-3 block h-px w-12 bg-brand" />
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
              : `Cancelled in the last ${windowLabel}`
          }
        >
          {churnRate.current === null ? (
            <span className="text-muted-foreground">{EM_DASH}</span>
          ) : (
            <CountUp value={churnRate.current} format="percent" digits={1} />
          )}
        </MetricTile>
      </div>

      <p className={cn(FOOTNOTE, "text-balance")}>{denominatorNote}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NRR over time
// ---------------------------------------------------------------------------

interface NrrTrendPanelProps {
  movementPromise: Promise<RevenueMovementPoint[]>;
}

export async function NrrTrendPanel({ movementPromise }: NrrTrendPanelProps) {
  const points = await movementPromise;
  const lastIndex = points.length - 1;

  const data: NrrLineDatum[] = points.map((point, index) => ({
    // `month` is the OPENING boundary of the window that moved — the convention
    // the whole movement series is labelled by.
    month: point.month,
    tick: formatMonthShort(point.month),
    heading: formatMonthLong(point.month),
    value: point.nrr,
    valueLabel: point.nrr === null ? EM_DASH : formatPercent(point.nrr, 1),
    // "Lifecycles", never "customers": this is a CHAIN count, and the schema has
    // no customer entity to promise one.
    cohortLabel:
      point.payingChainsAtStart === 0
        ? "Nothing was billing when the month opened"
        : `${formatCount(point.payingChainsAtStart)} paying ${
            point.payingChainsAtStart === 1 ? "lifecycle" : "lifecycles"
          } at the open`,
    // Only the endpoint is labelled; everything else is the axis and the tooltip.
    labelText:
      index === lastIndex && point.nrr !== null ? formatPercent(point.nrr, 0) : null,
  }));

  // Two different empty states. No rows at all means the workspace has never
  // billed across a month boundary; rows that are all null mean months passed
  // with nothing to retain. A blank plot area would say neither.
  const hasSeries = data.some((point) => point.value !== null);

  return (
    <Card className="h-full gap-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-brand" />
          <h2 className={EYEBROW}>NRR over time</h2>
        </div>
        {hasSeries ? (
          <CardAction>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatCount(data.length)} months
            </span>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent>
        {!hasSeries ? (
          <EmptyState
            icon={ChartSpline}
            title={
              data.length === 0 ? "No retention history yet" : "Nothing to retain yet"
            }
            description={
              data.length === 0
                ? "The line draws itself once a subscription has billed across a month boundary."
                : "Every month so far opened with no paying subscription, so retention has no defined value in any of them."
            }
            className="border-0 bg-transparent py-10"
          />
        ) : (
          <NrrLineChart data={data} />
        )}
      </CardContent>

      {hasSeries ? (
        <CardContent className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
          <p className={cn(FOOTNOTE, "font-mono")}>
            Vertical axis in percent, from zero
          </p>
          <p className={cn(FOOTNOTE, "text-balance")}>
            Each point follows one month&rsquo;s opening cohort to the next month
            boundary. The dashed rule is 100%: above it the cohort is worth more than
            it was, before a single new customer is counted. Twelve months, not
            scoped to the period above.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Churn over time
// ---------------------------------------------------------------------------

interface ChurnTrendPanelProps {
  churnTrendPromise: Promise<ChurnRateTrendPoint[]>;
}

export async function ChurnTrendPanel({ churnTrendPromise }: ChurnTrendPanelProps) {
  const points = await churnTrendPromise;
  const lastIndex = points.length - 1;

  const data: ChurnLineDatum[] = points.map((point, index) => ({
    month: point.month,
    tick: formatMonthShort(point.month),
    heading: formatMonthLong(point.month),
    value: point.rate,
    valueLabel: point.rate === null ? EM_DASH : formatPercent(point.rate, 1),
    cohortLabel:
      point.activeAtStart === 0
        ? "No subscription was live when the month opened"
        : `${formatCount(point.churned)} of ${formatCount(
            point.activeAtStart,
          )} cancelled`,
    labelText:
      index === lastIndex && point.rate !== null ? formatPercent(point.rate, 1) : null,
  }));

  const hasSeries = data.some((point) => point.value !== null);

  return (
    <Card className="h-full gap-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-negative" />
          <h2 className={EYEBROW}>Churn over time</h2>
        </div>
        {hasSeries ? (
          <CardAction>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatCount(data.length)} months
            </span>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent>
        {!hasSeries ? (
          <EmptyState
            icon={ChartSpline}
            title={data.length === 0 ? "No churn history yet" : "No churn to measure yet"}
            description={
              data.length === 0
                ? "The line draws itself once a full calendar month has passed."
                : "Every month so far opened with no live subscription, so there was no cohort that could churn."
            }
            className="border-0 bg-transparent py-10"
          />
        ) : (
          <ChurnLineChart data={data} />
        )}
      </CardContent>

      {hasSeries ? (
        <CardContent className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
          <p className={cn(FOOTNOTE, "font-mono")}>
            Vertical axis in percent, from zero
          </p>
          <p className={cn(FOOTNOTE, "text-balance")}>
            Subscriptions live at each month&rsquo;s open that cancelled before it
            closed. Counted per subscription, not per dollar, so a large account and a
            small one weigh the same. Twelve months, not scoped to the period above.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Where the latest month went
// ---------------------------------------------------------------------------

interface MovementSectionProps {
  /** The SAME promise the NRR panel reads. One query, two sections. */
  movementPromise: Promise<RevenueMovementPoint[]>;
  /** Only for the currency; every figure below comes from the movement row. */
  summaryPromise: Promise<MetricsSummary>;
}

/**
 * The most recent month, set as double-entry arithmetic.
 *
 * NRR is not a number, it is a subtotal. The left column runs the opening balance
 * through the only three movements retention is allowed to count, and lands on
 * `Retained MRR` — which IS the NRR numerator, not an approximation of it. The
 * right column carries that subtotal forward and adds the two movements that are
 * growth rather than retention, closing on the reported ending balance.
 *
 * Splitting the bridge in half is the point: it puts a visible line between "what
 * we kept" and "what we won", which a single seven-term identity does not.
 */
export async function MovementSection({
  movementPromise,
  summaryPromise,
}: MovementSectionProps) {
  const [points, summary] = await Promise.all([movementPromise, summaryPromise]);
  const { currency } = summary;

  if (points.length === 0) {
    return (
      <Card className="h-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <span aria-hidden className="size-1.5 rounded-full bg-brand" />
            <h2 className={EYEBROW}>Where the month went</h2>
          </div>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={ArrowLeftRight}
            title="No revenue movement yet"
            description="This ledger fills in once a subscription has billed across a month boundary. Nothing has moved in this workspace so far."
            className="border-0 bg-transparent py-12"
          />
        </CardContent>
      </Card>
    );
  }

  // The most recent row — the same "current" convention the revenue bridge uses
  // for its closing balance.
  const last: RevenueMovementPoint = points[points.length - 1];

  // Exactly the NRR numerator: starting + expansion − contraction − churned.
  // New and reactivation are excluded by construction, and that exclusion is
  // what separates retention from growth.
  const retainedCents: number =
    last.startingMRRCents +
    last.expansionMRRCents -
    last.contractionMRRCents -
    last.churnedMRRCents;

  const netCents: number = last.endingMRRCents - last.startingMRRCents;

  // The reported figure, never a recomputed one — a locally divided
  // retained/starting could drift from what the metrics layer says elsewhere on
  // this page.
  const retainedNote: string =
    last.nrr === null
      ? "Nothing was billing when the month opened, so retention has no defined value here."
      : `${formatPercent(last.nrr, 1)} of the opening balance — this month's net revenue retention.`;

  const endingNote: string = `${formatMoneyMovement(
    netCents,
    currency,
    netCents < 0 ? "subtract" : "add",
  )} net for the month.`;

  return (
    <Card className="h-full gap-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-brand" />
          <h2 className={EYEBROW}>Movement in {formatMonthLong(last.month)}</h2>
        </div>
        <CardAction>
          <ScopeTag>1 month</ScopeTag>
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className={cn(FOOTNOTE, "text-balance")}>
          {last.isComplete
            ? "Measured between month boundaries. The opening balance runs down the left, growth down the right, and the two meet at the close."
            : "This month is still open, so the ledger covers movement so far. The opening balance runs down the left, growth down the right."}
        </p>
      </CardContent>

      <CardContent className="grid gap-x-10 gap-y-5 md:grid-cols-2">
        <div className="flex flex-col">
          <h3 className={cn(EYEBROW, "mb-1.5")}>Retained</h3>
          {/*
            The two columns hold a different number of movements, so their
            subtotal rules would sit at different heights. Bottom-anchoring the
            rows puts the two rules on one line, which is the whole reason a
            ledger uses a rule. The slack lands under the heading, where it is
            invisible; on a stacked phone layout there is no slack to place.
          */}
          <span aria-hidden className="hidden grow md:block" />
          <LedgerRow
            label="Starting MRR"
            amount={formatMoney(last.startingMRRCents, currency)}
          />
          <LedgerRow
            label="Expansion"
            amount={formatMoneyMovement(last.expansionMRRCents, currency, "add")}
            tone="positive"
            indent
          />
          <LedgerRow
            label="Contraction"
            amount={formatMoneyMovement(last.contractionMRRCents, currency, "subtract")}
            tone="negative"
            indent
          />
          <LedgerRow
            label="Churned"
            amount={formatMoneyMovement(last.churnedMRRCents, currency, "subtract")}
            tone="negative"
            indent
          />
          <LedgerRow
            label="Retained MRR"
            amount={formatMoney(retainedCents, currency)}
            total
          />
          <p className={cn(FOOTNOTE, "mt-1.5 pl-4 text-balance")}>{retainedNote}</p>
        </div>

        <div className="flex flex-col">
          <h3 className={cn(EYEBROW, "mb-1.5")}>Growth</h3>
          <span aria-hidden className="hidden grow md:block" />
          <LedgerRow
            label="Retained MRR"
            amount={formatMoney(retainedCents, currency)}
            carried
          />
          <LedgerRow
            label="New"
            amount={formatMoneyMovement(last.newMRRCents, currency, "add")}
            tone="positive"
            indent
          />
          <LedgerRow
            label="Reactivation"
            amount={formatMoneyMovement(last.reactivationMRRCents, currency, "add")}
            tone="positive"
            indent
          />
          {/* Read straight off the reported row, never accumulated from the cells
              above it, so the two can never disagree. */}
          <LedgerRow
            label="Ending MRR"
            amount={formatMoney(last.endingMRRCents, currency)}
            total
          />
          <p className={cn(FOOTNOTE, "mt-1.5 pl-4 text-balance")}>{endingNote}</p>
        </div>
      </CardContent>

      <CardContent className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
        <p className={cn(FOOTNOTE, "font-mono")}>One calendar month, in {currency}</p>
        <p className={cn(FOOTNOTE, "text-balance")}>
          Retention counts only the three movements inside the opening cohort. New and
          reactivation close the month&rsquo;s arithmetic but never enter NRR. This
          card is a single month and does not follow the period control above.
        </p>
      </CardContent>
    </Card>
  );
}

interface LedgerRowProps {
  label: string;
  /** Already formatted, sign included. */
  amount: string;
  tone?: "positive" | "negative";
  /** Movements are indented under the balance they act on. */
  indent?: boolean;
  /** A subtotal or a close: rule above, and set in the balance weight. */
  total?: boolean;
  /** A balance carried in from the column beside it. Present, but quiet. */
  carried?: boolean;
}

/**
 * One line of the ledger: label, leader rule, right-aligned monospaced figure.
 * The leader rule is what ties a label to a figure across a wide gap, and it is
 * the same device the overview's NRR ledger uses.
 */
function LedgerRow({
  label,
  amount,
  tone,
  indent = false,
  total = false,
  carried = false,
}: LedgerRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-[0.5rem_auto_1fr_auto] items-center gap-x-2 py-1.5 text-[0.8125rem]",
        total && "mt-1 border-t border-border pt-2.5",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-[1px]",
          tone === "positive" && "bg-positive",
          tone === "negative" && "bg-negative",
        )}
      />
      <span
        className={cn(
          "text-muted-foreground",
          indent && "ml-3",
          total && "text-foreground",
        )}
      >
        {label}
      </span>
      {/* Leader rule — the ledger device that ties a label to a figure across a gap. */}
      <span aria-hidden className="h-px bg-border" />
      <span
        className={cn(
          "text-right font-mono tabular-nums",
          total ? "font-medium text-foreground" : "text-foreground",
          carried && "text-muted-foreground",
        )}
      >
        {amount}
      </span>
    </div>
  );
}
