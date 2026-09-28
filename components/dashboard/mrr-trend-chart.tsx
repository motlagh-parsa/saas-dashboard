"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCount, formatMoney, formatMoneyCompact } from "@/lib/format";

export interface MRRTrendDatum {
  /** `YYYY-MM`, kept for the key and the tooltip heading. */
  month: string;
  /** Axis tick: `Mar`. */
  tick: string;
  /** Tooltip heading: `Mar 2026`. */
  heading: string;
  mrrCents: number;
  /** Customers with MRR > 0 at the month-end snapshot. */
  activeCustomers: number;
}

interface MRRTrendChartProps {
  data: MRRTrendDatum[];
  currency: string;
}

/**
 * The page's hero visual: one series, month-end MRR, over twelve months.
 *
 * Chart decisions worth stating:
 *   - ONE series and ONE axis. Active customers live on a different scale and
 *     get their own panel; a second y-axis here would be the single most
 *     misleading thing this dashboard could do.
 *   - Zero baseline. The fill reads as magnitude, so the area has to measure from
 *     nothing or it exaggerates growth.
 *   - No legend. A single series is named by the panel title.
 *   - Everything — grid, ticks, stroke, fill, cursor, active dot — is a theme
 *     token, so light and dark are one implementation.
 */
export function MRRTrendChart({ data, currency }: MRRTrendChartProps) {
  return (
    <div className="h-56 w-full sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            {/*
              A single-hue fade from the series colour to nothing. Not a
              decorative gradient — it is the area's magnitude falling off toward
              the baseline. One instance per page, so a static id is safe.
            */}
            <linearGradient id="meridian-mrr-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.26} />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.01} />
            </linearGradient>
          </defs>

          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />

          <XAxis
            dataKey="tick"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            minTickGap={12}
            interval="preserveStartEnd"
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          <YAxis
            width={58}
            axisLine={false}
            tickLine={false}
            tickCount={4}
            domain={[0, "auto"]}
            tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          <Tooltip
            cursor={{ stroke: "var(--brand)", strokeWidth: 1, strokeDasharray: "4 4" }}
            content={<TrendTooltip currency={currency} />}
          />

          <Area
            type="monotone"
            dataKey="mrrCents"
            name="Monthly recurring revenue"
            stroke="var(--brand)"
            strokeWidth={2}
            fill="url(#meridian-mrr-fill)"
            fillOpacity={1}
            dot={false}
            activeDot={{
              r: 4,
              fill: "var(--brand)",
              stroke: "var(--card)",
              strokeWidth: 2,
            }}
            animationDuration={900}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TrendTooltipProps {
  currency: string;
  /** Injected by Recharts when it clones this element. */
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: MRRTrendDatum }>;
}

/**
 * Values and labels wear text tokens; the small brass rule carries the series
 * identity. Tinting the number itself would make colour do a job type is better
 * at, and would fail contrast the moment the series colour changed.
 */
function TrendTooltip({ active, payload, currency }: TrendTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="min-w-40 rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        {point.heading}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span aria-hidden className="h-3 w-0.5 rounded-full bg-brand" />
        <span className="font-mono text-sm text-foreground">
          {formatMoney(point.mrrCents, currency)}
        </span>
      </div>
      <p className="mt-1 pl-3.5 text-xs text-muted-foreground">
        {formatCount(point.activeCustomers)} active {point.activeCustomers === 1 ? "customer" : "customers"}
      </p>
    </div>
  );
}
