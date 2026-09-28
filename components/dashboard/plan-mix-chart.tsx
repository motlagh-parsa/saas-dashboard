"use client";

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatPercent } from "@/lib/format";

export interface PlanMixDatum {
  /** Plan id, or "custom" — the React key. */
  key: string;
  /** Axis label: the plan's name, or "Custom". */
  label: string;
  mrrCents: number;
  /** Pre-formatted money, e.g. `$12,400`, used as the bar's direct label. */
  valueLabel: string;
  /** Share of live MRR, as a fraction. */
  share: number;
  /** Pre-formatted count line for the tooltip. */
  subscriptions: string;
  /** Custom-priced subscriptions are drawn in the neutral, not the brand, colour. */
  isCustom: boolean;
}

interface PlanMixChartProps {
  data: PlanMixDatum[];
}

/** Row height in px; the chart grows with the number of plans rather than squeezing them. */
const ROW_HEIGHT = 30;

/**
 * Live MRR by plan, highest first.
 *
 * Plans are the founder's own and carry no inherent order, so this is one hue
 * with length doing all the work — a categorical palette would invent a
 * difference between plans that is not there, and a ramp would invent a rank.
 * "Custom" (no plan) is set in the neutral so it reads as a different kind of
 * thing, not as one more plan.
 *
 * Horizontal bars because the categories are words: they read left-to-right at
 * full size instead of being rotated or truncated under a vertical bar.
 */
export function PlanMixChart({ data }: PlanMixChartProps) {
  return (
    <div className="w-full" style={{ height: Math.max(ROW_HEIGHT * data.length + 16, 96) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
          barCategoryGap={10}
        >
          {/* Numeric and anchored at zero — bars measure from nothing or they lie.
              Hidden because every bar is direct-labelled. */}
          <XAxis type="number" domain={[0, "dataMax"]} hide />

          <YAxis
            type="category"
            dataKey="label"
            width={104}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          <Tooltip cursor={{ fill: "var(--accent)" }} content={<PlanTooltip />} />

          <Bar
            dataKey="mrrCents"
            barSize={14}
            radius={[0, 4, 4, 0]}
            animationDuration={700}
            animationEasing="ease-out"
          >
            {data.map((entry) => (
              <Cell
                key={entry.key}
                fill={entry.isCustom ? "var(--muted-foreground)" : "var(--brand)"}
              />
            ))}
            <LabelList
              dataKey="valueLabel"
              position="right"
              offset={10}
              fill="var(--foreground)"
              fontSize={11}
              fontFamily="var(--font-geist-mono)"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface PlanTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: PlanMixDatum }>;
}

function PlanTooltip({ active, payload }: PlanTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-foreground">{point.label}</p>
      <p className="mt-1 font-mono text-sm text-foreground">{point.valueLabel}</p>
      <p className="text-xs text-muted-foreground">
        {formatPercent(point.share, 0)} of live MRR · {point.subscriptions}
      </p>
    </div>
  );
}
