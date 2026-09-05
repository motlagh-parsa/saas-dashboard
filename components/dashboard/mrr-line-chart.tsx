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

import { formatMoneyCompact } from "@/lib/format";

export interface MRRLineDatum {
  /** `YYYY-MM` — the React key and the identity of the point. */
  month: string;
  /** Axis tick: `Mar`. */
  tick: string;
  /** Tooltip heading: `Mar 2026`. */
  heading: string;
  /** Plotted value, in cents. */
  mrrCents: number;
  /** Pre-formatted money for the tooltip. */
  amount: string;
  /** Pre-formatted subscription count line. */
  subscriptions: string;
  /** Direct label, or null. Only the endpoint carries one. */
  labelText: string | null;
}

interface MRRLineChartProps {
  data: MRRLineDatum[];
  currency: string;
}

/**
 * Month-end MRR level, as a companion to the bridge beside it.
 *
 * This is a SEPARATE chart with its own axis, deliberately. Level and movement
 * differ by an order of magnitude, and putting them on one plot would need two
 * y-scales — the single most misleading thing a dashboard can do. Two charts, two
 * axes, each honest on its own.
 *
 * The axis starts at zero, matching the bridge and the overview, so the same
 * metric never changes its baseline between screens. Only the endpoint is
 * direct-labelled; the rest is the axis and the tooltip.
 */
export function MRRLineChart({ data, currency }: MRRLineChartProps) {
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
            width={54}
            axisLine={false}
            tickLine={false}
            tickCount={3}
            domain={[0, "auto"]}
            tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          <Tooltip
            cursor={{ stroke: "var(--brand)", strokeWidth: 1, strokeDasharray: "4 4" }}
            content={<LineTooltip />}
          />

          {/* One series, so no legend: the panel title names it. */}
          <Line
            type="monotone"
            dataKey="mrrCents"
            name="Month-end MRR"
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

interface LineTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: MRRLineDatum }>;
}

function LineTooltip({ active, payload }: LineTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="min-w-40 rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        {point.heading}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span aria-hidden className="h-3 w-0.5 rounded-full bg-brand" />
        <span className="font-mono text-sm text-foreground">{point.amount}</span>
      </div>
      <p className="mt-1 pl-3.5 text-xs text-muted-foreground">{point.subscriptions}</p>
    </div>
  );
}
