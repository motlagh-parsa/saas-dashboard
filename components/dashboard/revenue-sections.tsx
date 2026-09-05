import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeftRight,
  Banknote,
  CalendarRange,
  ChartSpline,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  FileClock,
  TriangleAlert,
} from "lucide-react";

import type {
  InvoiceListResult,
  InvoiceTotals,
  MRRTrendPoint,
  MetricsSummary,
  RevenueMovementPoint,
} from "@/lib/metrics";
import {
  formatCount,
  formatDay,
  formatMonthLong,
  formatMonthShort,
  formatMoney,
  formatMoneyCompact,
  formatMoneyMovement,
} from "@/lib/format";
import type { RangeKey } from "@/lib/period";
import {
  STATUS_FILTERS,
  type StatusFilterKey,
  encodeCursor,
  encodeCursorStack,
  statusFilterOption,
} from "@/lib/invoice-filter";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { CountUp } from "@/components/dashboard/count-up";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InvoiceTable } from "@/components/dashboard/invoice-table";
import { MetricTile } from "@/components/dashboard/metric-tile";
import { NavChip } from "@/components/dashboard/nav-chip";
import { MRRLineChart, type MRRLineDatum } from "@/components/dashboard/mrr-line-chart";
import { RevenueBridgeChart } from "@/components/dashboard/revenue-bridge-chart";
import {
  BRIDGE_FILL,
  BRIDGE_HATCH_FILL,
  BridgeSwatch,
  type BridgeComponent,
  type BridgeDatum,
  type BridgeDirection,
} from "@/components/dashboard/bridge-encoding";

/**
 * The revenue page's data-owning sections.
 *
 * Each one awaits only the queries it renders, so the page can hand every section
 * its own `<Suspense>` boundary and stream them independently instead of blocking
 * the route on the slowest statement. The promises are started by the page, in
 * parallel, before any of these is reached.
 *
 * Everything a client chart receives has already been formatted here. Money never
 * leaves this file as cents-plus-currency, months never leave as Dates, and no
 * function is ever handed across the boundary.
 */

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

const REVENUE_PATH = "/dashboard/revenue";

/**
 * Every URL this page links to.
 *
 * `range` always travels, because the period scopes the tiles. `status` is
 * omitted at its default so a shared link stays readable. Cursors are passed
 * explicitly by each caller, which is what makes a filter change RESET paging
 * rather than silently carry a cursor into a different result set.
 */
function revenueHref(
  range: RangeKey,
  status: StatusFilterKey,
  cursors: readonly string[],
): string {
  const query = new URLSearchParams({ range });
  if (status !== "all") query.set("status", status);
  if (cursors.length > 0) query.set("cursors", encodeCursorStack(cursors));
  return `${REVENUE_PATH}?${query.toString()}`;
}

/**
 * The schema stores no FX rates, so a multi-currency total adds unlike amounts.
 * That has to be said where the number is, not in a footnote nobody reads.
 */
function MixedCurrencyNote({ subject }: { subject: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground text-balance">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
      <span>
        {subject} bill in more than one currency and no exchange rates are stored,
        so this figure adds unlike amounts. Read it as an approximation until rates
        are configured.
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// The bridge — the page's thesis
// ---------------------------------------------------------------------------

interface MovementSums {
  newCents: number;
  reactivationCents: number;
  expansionCents: number;
  contractionCents: number;
  churnedCents: number;
}

/**
 * The non-zero components of a single month, for its tooltip.
 *
 * Amounts are UNSIGNED. `contractionMRRCents` and `churnedMRRCents` arrive as
 * positive magnitudes that represent decreases, and the operator rendered beside
 * each label is what carries the direction. Running them through
 * `formatMoneyMovement` as well would print the minus twice.
 */
function componentsOf(
  point: RevenueMovementPoint,
  currency: string,
): BridgeComponent[] {
  const entries: ReadonlyArray<readonly [string, number, "up" | "down"]> = [
    ["New", point.newMRRCents, "up"],
    ["Reactivation", point.reactivationMRRCents, "up"],
    ["Expansion", point.expansionMRRCents, "up"],
    ["Contraction", point.contractionMRRCents, "down"],
    ["Churned", point.churnedMRRCents, "down"],
  ];

  return entries
    .filter(([, cents]) => cents > 0)
    .map(([label, cents, direction]) => ({
      label,
      amount: formatMoney(cents, currency),
      direction,
    }));
}

/**
 * Turns the movement series into bridge columns.
 *
 * Two rules keep the geometry honest:
 *
 *   - Every column is read from its OWN row. A month floats from its
 *     `startingMRRCents` to its `endingMRRCents`, and the closing balance is
 *     `endingMRRCents` of the last row, not a running total accumulated across
 *     twelve additions. An accumulator would be free to drift away from the
 *     figure the metrics layer actually reports.
 *   - A month that did not move gets a hairline instead of nothing. A zero-height
 *     bar and a missing bar look identical, and "no change" is not "no data".
 */
function buildBridge(
  points: readonly RevenueMovementPoint[],
  currency: string,
): BridgeDatum[] {
  const first = points[0];
  const last = points[points.length - 1];

  const domainMax = points.reduce(
    (peak, point) => Math.max(peak, point.startingMRRCents, point.endingMRRCents),
    0,
  );
  const hairline = Math.max(1, Math.round(domainMax * 0.006));

  const columns: BridgeDatum[] = [
    {
      key: "balance-opening",
      tick: "Start",
      heading: `Balance at ${formatDay(first.periodStart)}`,
      caption: "MRR carried into the window.",
      direction: "balance",
      fill: BRIDGE_HATCH_FILL,
      base: 0,
      span: first.startingMRRCents,
      amount: formatMoney(first.startingMRRCents, currency),
      level: formatMoney(first.startingMRRCents, currency),
      labelText: formatMoneyCompact(first.startingMRRCents, currency),
      components: [],
    },
  ];

  for (const point of points) {
    const start = point.startingMRRCents;
    const end = point.endingMRRCents;
    const delta = end - start;
    const magnitude = Math.abs(delta);
    const rising = delta > 0;
    const open = !point.isComplete;

    let direction: BridgeDirection = "flat";
    let fill: string = BRIDGE_FILL.flat;
    if (delta > 0) {
      direction = "up";
      fill = open ? BRIDGE_FILL.upInProgress : BRIDGE_FILL.up;
    } else if (delta < 0) {
      direction = "down";
      fill = open ? BRIDGE_FILL.downInProgress : BRIDGE_FILL.down;
    }

    columns.push({
      // `month` is `to_char(periodStart, 'YYYY-MM')` — the OPENING boundary of
      // the window that moved, which is the convention the whole movement series
      // is labelled by. It is not the trend series' snapshot date.
      key: point.month,
      tick: formatMonthShort(point.month),
      heading: formatMonthLong(point.month),
      caption: open
        ? "This month is still open. The column covers movement so far."
        : null,
      direction,
      fill,
      // A rise stands on the opening level; a fall hangs from the closing one.
      base: rising ? start : end,
      span: magnitude === 0 ? hairline : magnitude,
      amount: formatMoneyMovement(magnitude, currency, delta < 0 ? "subtract" : "add"),
      level: formatMoney(end, currency),
      labelText: null,
      components: componentsOf(point, currency),
    });
  }

  columns.push({
    key: "balance-closing",
    tick: last.isComplete ? "End" : "Now",
    heading: `Balance at ${formatDay(last.periodEnd)}`,
    caption: last.isComplete
      ? "MRR at the close of the window."
      : "MRR right now. The current month is still open.",
    direction: "balance",
    fill: BRIDGE_HATCH_FILL,
    base: 0,
    // The reported ending figure, used directly.
    span: last.endingMRRCents,
    amount: formatMoney(last.endingMRRCents, currency),
    level: formatMoney(last.endingMRRCents, currency),
    labelText: formatMoneyCompact(last.endingMRRCents, currency),
    components: [],
  });

  return columns;
}

interface StripCell {
  key: string;
  /** The arithmetic operator, which is what carries direction here. */
  operator: string | null;
  label: string;
  /** Unsigned magnitude — the operator already said which way it goes. */
  amount: string;
  tone: "up" | "down" | "total";
  /** Says so out loud when a component contributed nothing. */
  note: string | null;
}

const STRIP_RULE: Record<StripCell["tone"], string> = {
  up: "border-movement-up",
  down: "border-movement-down",
  total: "border-foreground/25",
};

function LegendItem({ direction, label }: { direction: BridgeDirection; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
      <BridgeSwatch direction={direction} />
      {label}
    </li>
  );
}

interface BridgePanelProps {
  movementPromise: Promise<RevenueMovementPoint[]>;
  /** Only for the currency and the mixed-currency flag; MRR itself comes from the bridge. */
  summaryPromise: Promise<MetricsSummary>;
}

export async function BridgePanel({ movementPromise, summaryPromise }: BridgePanelProps) {
  const [points, summary] = await Promise.all([movementPromise, summaryPromise]);
  const { currency, isMixedCurrency } = summary;

  if (points.length === 0) {
    return (
      <Card className="h-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <span aria-hidden className="size-1.5 rounded-full bg-brand" />
            <h2 className={EYEBROW}>Revenue bridge</h2>
          </div>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={ArrowLeftRight}
            title="No revenue movement yet"
            description="The bridge draws itself once a subscription has billed across a month boundary. Nothing has moved in this workspace so far."
            className="border-0 bg-transparent py-12"
          />
        </CardContent>
      </Card>
    );
  }

  const first = points[0];
  const last = points[points.length - 1];
  const columns = buildBridge(points, currency);

  const netCents = last.endingMRRCents - first.startingMRRCents;
  const netLabel = formatMoneyMovement(
    netCents,
    currency,
    netCents < 0 ? "subtract" : "add",
  );
  // The sign glyph is taken from the formatter's own output rather than written
  // out again here, so the two can never disagree about which minus to use.
  const sign = netCents === 0 ? null : netLabel.slice(0, 1);

  const sums: MovementSums = points.reduce<MovementSums>(
    (acc, point) => ({
      newCents: acc.newCents + point.newMRRCents,
      reactivationCents: acc.reactivationCents + point.reactivationMRRCents,
      expansionCents: acc.expansionCents + point.expansionMRRCents,
      contractionCents: acc.contractionCents + point.contractionMRRCents,
      churnedCents: acc.churnedCents + point.churnedMRRCents,
    }),
    {
      newCents: 0,
      reactivationCents: 0,
      expansionCents: 0,
      contractionCents: 0,
      churnedCents: 0,
    },
  );

  const zeroNote = (cents: number): string | null =>
    cents === 0 ? "none in window" : null;

  const strip: StripCell[] = [
    {
      key: "starting",
      operator: null,
      label: "Starting",
      amount: formatMoney(first.startingMRRCents, currency),
      tone: "total",
      note: null,
    },
    {
      key: "new",
      operator: "+",
      label: "New",
      amount: formatMoney(sums.newCents, currency),
      tone: "up",
      note: zeroNote(sums.newCents),
    },
    {
      key: "reactivation",
      operator: "+",
      label: "Reactivation",
      amount: formatMoney(sums.reactivationCents, currency),
      tone: "up",
      note: zeroNote(sums.reactivationCents),
    },
    {
      key: "expansion",
      operator: "+",
      label: "Expansion",
      amount: formatMoney(sums.expansionCents, currency),
      tone: "up",
      note: zeroNote(sums.expansionCents),
    },
    {
      key: "contraction",
      operator: "−",
      label: "Contraction",
      amount: formatMoney(sums.contractionCents, currency),
      tone: "down",
      note: zeroNote(sums.contractionCents),
    },
    {
      key: "churned",
      operator: "−",
      label: "Churned",
      amount: formatMoney(sums.churnedCents, currency),
      tone: "down",
      note: zeroNote(sums.churnedCents),
    },
    {
      key: "ending",
      operator: "=",
      label: "Ending",
      // Read straight off the last row, never accumulated from the six cells left of it.
      amount: formatMoney(last.endingMRRCents, currency),
      tone: "total",
      note: null,
    },
  ];

  const hasFlatMonth = columns.some((column) => column.direction === "flat");
  const caption = last.isComplete
    ? "Each column is one month of net movement, measured between month boundaries. Balances sit on the zero line; movement floats from it."
    : `Each column is one month of net movement, measured between month boundaries. ${formatMonthLong(last.month)} is still open, so its column is drawn at reduced strength.`;

  return (
    <Card className="h-full gap-5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-brand" />
          <h2 className={EYEBROW}>Revenue bridge</h2>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(points.length)} months
          </span>
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className="flex items-baseline">
          <span className="sr-only">{netLabel}</span>
          {/* aria-hidden covers the whole group so the counter does not read its
              own unsigned value a second time. */}
          <span aria-hidden className="flex items-baseline gap-0.5">
            {sign ? (
              <span className="font-mono text-3xl leading-none text-muted-foreground sm:text-4xl">
                {sign}
              </span>
            ) : null}
            <CountUp
              value={Math.abs(netCents)}
              format="money"
              currency={currency}
              className="font-mono text-[2.5rem] leading-none tracking-[-0.035em] text-foreground tabular-nums sm:text-5xl"
            />
          </span>
        </p>

        {/* The brass rule sits under the one number this page exists to report. */}
        <span aria-hidden className="mt-3.5 block h-px w-14 bg-brand" />

        <p className="mt-3 text-[0.8125rem] text-muted-foreground text-balance">
          Net movement from {formatMoney(first.startingMRRCents, currency)} on{" "}
          {formatDay(first.periodStart)} to {formatMoney(last.endingMRRCents, currency)} on{" "}
          {formatDay(last.periodEnd)}
        </p>

        {isMixedCurrency ? (
          <div className="mt-3">
            <MixedCurrencyNote subject="Subscriptions" />
          </div>
        ) : null}
      </CardContent>

      <CardContent>
        <RevenueBridgeChart data={columns} currency={currency} />
      </CardContent>

      {/*
        Legend and axis labelling live in HTML, not inside the SVG: they read at
        the body type size, they wear text tokens rather than the series colour,
        and they do not steal plot area.

        The encoding is named in words here on purpose. Elsewhere in the product
        emerald means "good" — on a delta badge, on a Paid invoice — and this
        chart uses steel for "increase" instead, because the emerald/rose pair is
        unreadable to a deuteranope at this contrast. Naming the encoding keeps
        the bridge self-contained rather than pretending the two systems agree.
      */}
      <CardContent className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-border pt-3">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <LegendItem direction="up" label="Increase" />
          <LegendItem direction="down" label="Decrease" />
          <LegendItem direction="balance" label="Balance" />
          {hasFlatMonth ? <LegendItem direction="flat" label="No change" /> : null}
        </ul>
        <p className="font-mono text-[0.6875rem] text-muted-foreground">
          Vertical axis in {currency}, from zero
        </p>
        <p className="w-full text-[0.6875rem] text-muted-foreground text-balance">
          {caption}
        </p>
      </CardContent>

      {/*
        The identity strip. A bridge is an equation, so it is set as one: the
        opening balance, the five movements with their operators, and the close.
        Amounts are unsigned magnitudes because the operator already carries the
        direction — printing both would read as subtracting a negative.
      */}
      <CardContent className="mt-auto border-t border-border pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className={EYEBROW}>Movement by kind</h3>
          <p className="text-[0.6875rem] text-muted-foreground">
            Opening balance plus the five movements equals the close
          </p>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:grid-cols-7">
          {strip.map((cell) => (
            <div
              key={cell.key}
              className={cn("flex flex-col gap-1 border-t-2 pt-2", STRIP_RULE[cell.tone])}
            >
              <dt className="flex items-center gap-1.5 font-mono text-[0.625rem] font-medium tracking-[0.1em] uppercase">
                <span
                  aria-hidden
                  className="w-2 shrink-0 text-center text-muted-foreground/60"
                >
                  {cell.operator}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate",
                    cell.tone === "total" ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {cell.label}
                </span>
              </dt>
              <dd
                className={cn(
                  "font-mono text-[0.8125rem] text-foreground tabular-nums",
                  cell.tone === "total" && "font-medium",
                )}
              >
                {cell.amount}
              </dd>
              {cell.note ? (
                <dd className="text-[0.6875rem] text-muted-foreground">{cell.note}</dd>
              ) : null}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MRR level — a separate chart, on its own scale
// ---------------------------------------------------------------------------

interface TrendPanelProps {
  trendPromise: Promise<MRRTrendPoint[]>;
  summaryPromise: Promise<MetricsSummary>;
}

export async function TrendPanel({ trendPromise, summaryPromise }: TrendPanelProps) {
  const [trend, summary] = await Promise.all([trendPromise, summaryPromise]);
  const { currency } = summary;

  const lastIndex = trend.length - 1;
  const points: MRRLineDatum[] = trend.map((point, index) => ({
    month: point.month,
    tick: formatMonthShort(point.month),
    heading: formatMonthLong(point.month),
    mrrCents: point.mrrCents,
    amount: formatMoney(point.mrrCents, currency),
    subscriptions: `${formatCount(point.activeSubs)} active ${
      point.activeSubs === 1 ? "subscription" : "subscriptions"
    }`,
    // Only the endpoint is labelled; everything else is the axis and the tooltip.
    labelText: index === lastIndex ? formatMoneyCompact(point.mrrCents, currency) : null,
  }));

  return (
    <Card className="h-full gap-4">
      <CardHeader>
        <h2 className={EYEBROW}>Month-end MRR</h2>
        {points.length > 0 ? (
          <CardAction>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatCount(points.length)} months
            </span>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent>
        {points.length === 0 ? (
          <EmptyState
            icon={ChartSpline}
            title="No history yet"
            description="The trend fills in once daily snapshots have covered a full month."
            className="border-0 bg-transparent py-10"
          />
        ) : (
          <MRRLineChart data={points} currency={currency} />
        )}
      </CardContent>

      {points.length > 0 ? (
        <CardContent className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
          <p className="font-mono text-[0.6875rem] text-muted-foreground">
            Vertical axis in {currency}, from zero
          </p>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            Read from the last daily snapshot in each month. The bridge measures at
            the month boundary instead, so the two can differ by a day of events
            around the first of a month.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Billing totals
// ---------------------------------------------------------------------------

/**
 * What KIND of quantity a tile holds.
 *
 * This is the tag that stops someone subtracting one tile from another. Collected
 * is a flow measured over the period; outstanding is a stock measured at a
 * moment, and it deliberately reaches back before the period. They are not
 * comparable, and the interface has to say so rather than hope.
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

interface RevenueTilesProps {
  summaryPromise: Promise<MetricsSummary>;
  totalsPromise: Promise<InvoiceTotals>;
}

export async function RevenueTiles({ summaryPromise, totalsPromise }: RevenueTilesProps) {
  const [summary, totals] = await Promise.all([summaryPromise, totalsPromise]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricTile
          label="Annual run rate"
          icon={CalendarRange}
          delta={<ScopeTag>Rate</ScopeTag>}
          footnote="Monthly recurring revenue × 12, at period end"
        >
          <CountUp
            value={summary.arrCents.current}
            format="money"
            currency={summary.currency}
          />
        </MetricTile>

        <MetricTile
          label="Collected"
          icon={Banknote}
          delta={<ScopeTag>Flow</ScopeTag>}
          footnote="Cash received in period, by paid date"
        >
          <CountUp
            value={totals.collectedCents}
            format="money"
            currency={totals.currency}
          />
        </MetricTile>

        <MetricTile
          label="Outstanding"
          icon={FileClock}
          delta={<ScopeTag>Stock</ScopeTag>}
          footnote="Open invoices as of today, including older periods"
        >
          <CountUp
            value={totals.outstandingCents}
            format="money"
            currency={totals.currency}
          />
        </MetricTile>
      </div>

      {totals.isMixedCurrency ? <MixedCurrencyNote subject="Invoices" /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

interface InvoiceLedgerProps {
  invoicesPromise: Promise<InvoiceListResult>;
  /** Carried into every link so a filter or page turn keeps the period. */
  range: RangeKey;
  status: StatusFilterKey;
  /**
   * The validated cursor stack for this render, oldest page first. Serializable
   * on purpose: this element is passed as `children` to a client error boundary,
   * so a href-building callback could not travel with it.
   */
  cursors: string[];
}

export async function InvoiceLedger({
  invoicesPromise,
  range,
  status,
  cursors,
}: InvoiceLedgerProps) {
  const { invoices, nextCursor } = await invoicesPromise;
  const option = statusFilterOption(status);

  const page = cursors.length + 1;
  const firstHref = cursors.length > 1 ? revenueHref(range, status, []) : null;
  const backHref =
    cursors.length > 0 ? revenueHref(range, status, cursors.slice(0, -1)) : null;
  const nextHref = nextCursor
    ? revenueHref(range, status, [...cursors, encodeCursor(nextCursor)])
    : null;

  // Three different reasons a table can be empty, and only one of them is
  // "this workspace has never billed anyone".
  let empty: ReactNode = undefined;
  if (invoices.length === 0 && cursors.length > 0) {
    empty = (
      <EmptyState
        icon={CircleSlash}
        title="This page is empty"
        description="The list has changed since this link was made. Go back to the first page to pick it up again."
        action={
          <Button asChild className="h-11 px-4 sm:h-9">
            <Link href={revenueHref(range, status, [])}>Back to the first page</Link>
          </Button>
        }
        className="mx-4 mb-4 border-0 bg-transparent py-10"
      />
    );
  } else if (invoices.length === 0 && status !== "all") {
    empty = (
      <EmptyState
        icon={CircleSlash}
        title={`No ${option.emptyNoun}`}
        description="Nothing in this workspace matches the filter. Clear it to see every invoice."
        action={
          <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
            <Link href={revenueHref(range, "all", [])}>Show all invoices</Link>
          </Button>
        }
        className="mx-4 mb-4 border-0 bg-transparent py-10"
      />
    );
  }

  const showPager = invoices.length > 0 || backHref !== null;

  return (
    <Card className="h-full gap-0 py-0">
      {/*
        The filter row sits above everything it scopes and nothing else. The
        period control in the page header governs the tiles; this governs the
        table, and the line underneath says which.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className={EYEBROW}>Invoices</h2>
        <div
          role="group"
          aria-label="Filter invoices by status"
          className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
        >
          {STATUS_FILTERS.map((filter) => (
            <NavChip
              key={filter.key}
              href={revenueHref(range, filter.key, [])}
              active={filter.key === status}
            >
              {filter.label}
            </NavChip>
          ))}
        </div>
      </div>

      <p className="border-b border-border px-4 py-2 text-[0.6875rem] text-muted-foreground text-balance">
        Every invoice in this workspace, newest first. Not scoped to the period
        above: an unpaid invoice stays outstanding until it is settled.
      </p>

      <InvoiceTable invoices={invoices} empty={empty} />

      {showPager ? (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          <p className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
            Page {formatCount(page)}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            {formatCount(invoices.length)}{" "}
            {invoices.length === 1 ? "invoice" : "invoices"}
          </p>

          <div className="flex items-center gap-0.5">
            {firstHref ? <NavChip href={firstHref}>First</NavChip> : null}
            {backHref ? (
              <NavChip href={backHref} label="Previous page">
                <ChevronLeft className="size-3.5" aria-hidden />
                Back
              </NavChip>
            ) : null}
            {nextHref ? (
              <NavChip href={nextHref} label="Next page">
                Next
                <ChevronRight className="size-3.5" aria-hidden />
              </NavChip>
            ) : null}
            {nextHref === null && invoices.length > 0 ? (
              <span className="px-2 text-[0.6875rem] text-muted-foreground">
                End of list
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
