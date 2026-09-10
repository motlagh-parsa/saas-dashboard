"use client";

import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatPercent } from "@/lib/format";

export interface ChurnLineDatum {
  /** `YYYY-MM` — the React key and the identity of the point. */
  month: string;
  /** Axis tick: `Mar`. */
  tick: string;
  /** Tooltip heading: `Mar 2026`. */
  heading: string;
  /**
   * Plotted value, as a FRACTION (0.05 = 5%).
   *
   * `null` travels all the way into Recharts, which draws it as a GAP. A month
   * with no subscriptions live at its start has no churn rate at all, and
   * plotting that as 0% would claim a perfect month that never happened.
   */
  value: number | null;
  /** Pre-formatted percent for the tooltip, or an em-dash. */
  valueLabel: string;
  /** Pre-formatted numerator/denominator line for the tooltip. */
  cohortLabel: string;
  /** Direct label, or null. Only the endpoint carries one. */
  labelText: string | null;
}

interface ChurnLineChartProps {
  data: ChurnLineDatum[];
}

/**
 * Subscription churn, month by month.
 *
 * Deliberately built to the same geometry as `NrrLineChart` beside it — same
 * height, same margins, same twelve-month x-axis, same tick density — so the
 * two panels can be read against each other by eye. They stay separate
 * components because they are separate series with separate scales; a shared
 * y-axis for a rate that lives near 0.03 and one that lives near 1.1 would
 * flatten both.
 *
 * The axis starts at zero and autoscales its top. No hardcoded ceiling: churn
 * is bounded at 100% in theory, and pinning the axis there would render every
 * real-world series as a flat line on the floor.
 *
 * This component does no null-handling and no formatting. Every string it
 * renders was produced server-side by `retention-sections.tsx`.
 */
export function ChurnLineChart({ data }: ChurnLineChartProps) {
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

          <Tooltip
            cursor={{ stroke: "var(--negative)", strokeWidth: 1, strokeDasharray: "4 4" }}
            content={<ChurnTooltip />}
          />

          {/* One series, so no legend: the panel title names it. */}
          <Line
            type="monotone"
            dataKey="value"
            name="Churn rate"
            stroke="var(--negative)"
            strokeWidth={2}
            dot={false}
            activeDot={{
              r: 4,
              fill: "var(--negative)",
              stroke: "var(--card)",
              strokeWidth: 2,
            }}
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

interface ChurnTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChurnLineDatum }>;
}

function ChurnTooltip({ active, payload }: ChurnTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        {point.heading}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span aria-hidden className="h-3 w-0.5 rounded-full bg-negative" />
        <span className="font-mono text-sm text-foreground">{point.valueLabel}</span>
      </div>
      <p className="mt-1 pl-3.5 text-xs text-muted-foreground">{point.cohortLabel}</p>
    </div>
  );
}
