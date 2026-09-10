"use client";

import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatPercent } from "@/lib/format";

export interface NrrLineDatum {
  /** `YYYY-MM` — the React key and the identity of the point. */
  month: string;
  /** Axis tick: `Mar`. */
  tick: string;
  /** Tooltip heading: `Mar 2026`. */
  heading: string;
  /**
   * Plotted value, as a FRACTION (1.12 = 112%).
   *
   * `null` travels all the way into Recharts, which draws it as a GAP. That is
   * the honest reading of "no cohort was billing when this month opened".
   * Coercing it to 0 would plot a month with nothing to retain as a total
   * wipeout, which is the opposite of what happened.
   */
  value: number | null;
  /** Pre-formatted percent for the tooltip, or an em-dash. */
  valueLabel: string;
  /** Pre-formatted denominator line for the tooltip. */
  cohortLabel: string;
  /** Direct label, or null. Only the endpoint carries one. */
  labelText: string | null;
}

interface NrrLineChartProps {
  data: NrrLineDatum[];
}

/**
 * Net revenue retention, month by month.
 *
 * The axis starts at zero, matching every other chart in the product, so the
 * same metric never changes its baseline between screens. It is NOT clamped at
 * the top: NRR above 100% is the whole point of the metric, and a ceiling would
 * flatten exactly the months worth reading.
 *
 * The dashed rule is 100% — the break-even line where the opening cohort is
 * worth what it was. `ifOverflow="extendDomain"` keeps it on the plot even when
 * every month sits below it, because "we are under break-even" is only legible
 * against the line it is under.
 *
 * This component does no null-handling and no formatting. Every string it
 * renders was produced server-side by `retention-sections.tsx`, which is what
 * keeps money, dates, and locale off the client.
 */
export function NrrLineChart({ data }: NrrLineChartProps) {
  return (
    <div className="h-44 w-full sm:h-52">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 20, right: 30, bottom: 0, left: 0 }}
          accessibilityLayer
        >
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
            width={46}
            axisLine={false}
            tickLine={false}
            tickCount={3}
            domain={[0, "auto"]}
            tickFormatter={(value: number) => formatPercent(value, 0)}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          {/* Break-even. Chrome, not data: it wears the axis-tick token so it
              never reads as a second series. The card's footer names it. */}
          <ReferenceLine
            y={1}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.45}
            strokeDasharray="4 4"
            ifOverflow="extendDomain"
          />

          <Tooltip
            cursor={{ stroke: "var(--brand)", strokeWidth: 1, strokeDasharray: "4 4" }}
            content={<NrrTooltip />}
          />

          {/* One series, so no legend: the panel title names it. */}
          <Line
            type="monotone"
            dataKey="value"
            name="Net revenue retention"
            stroke="var(--brand)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "var(--brand)", stroke: "var(--card)", strokeWidth: 2 }}
            animationDuration={800}
            animationEasing="ease-out"
          >
            <LabelList
              dataKey="labelText"
              position="top"
              offset={10}
              fill="var(--foreground)"
              fontSize={11}
              fontFamily="var(--font-geist-mono)"
            />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface NrrTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: NrrLineDatum }>;
}

function NrrTooltip({ active, payload }: NrrTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        {point.heading}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span aria-hidden className="h-3 w-0.5 rounded-full bg-brand" />
        <span className="font-mono text-sm text-foreground">{point.valueLabel}</span>
      </div>
      <p className="mt-1 pl-3.5 text-xs text-muted-foreground">{point.cohortLabel}</p>
    </div>
  );
}
