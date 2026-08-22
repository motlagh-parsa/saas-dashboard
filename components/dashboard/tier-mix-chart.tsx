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

import { formatCount, formatPercent } from "@/lib/format";

export interface TierDatum {
  /** Raw enum value — the stable identity the colour is bound to. */
  tier: string;
  /** Axis label: `Enterprise`. */
  label: string;
  count: number;
  /** Share of live subscriptions, as a fraction. */
  share: number;
  /** `var(--tier-N)` — the ramp step for this tier's RANK, never its count. */
  fill: string;
}

interface TierMixChartProps {
  data: TierDatum[];
}

/**
 * Live subscriptions by plan tier.
 *
 * Form: plan tiers are ORDINAL (FREE < STARTER < PRO < ENTERPRISE), not four
 * unrelated identities, so this is a single-hue SEQUENTIAL brass ramp rather
 * than a categorical palette. Rows are ordered by tier RANK, top to bottom, so
 * the ramp and the ordering encode the same fact and a change in counts can
 * never repaint a tier.
 *
 * Horizontal bars because the categories are words: they read left-to-right at
 * full size instead of being rotated or truncated under a vertical bar.
 */
export function TierMixChart({ data }: TierMixChartProps) {
  return (
    <div className="h-36 w-full sm:h-40">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 44, bottom: 0, left: 0 }}
          barCategoryGap={10}
        >
          {/*
            Declared so the value scale is numeric and anchored at zero — bars
            measure from nothing or they lie. Hidden because the four bars are
            direct-labelled; rendering ticks as well would print every count
            twice.
          */}
          <XAxis type="number" domain={[0, "dataMax"]} hide />

          <YAxis
            type="category"
            dataKey="label"
            width={86}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />

          <Tooltip
            cursor={{ fill: "var(--accent)" }}
            content={<TierTooltip />}
          />

          <Bar
            dataKey="count"
            barSize={14}
            radius={[0, 4, 4, 0]}
            animationDuration={700}
            animationEasing="ease-out"
          >
            {data.map((entry) => (
              <Cell key={entry.tier} fill={entry.fill} />
            ))}
            {/*
              Four marks, so the counts are direct-labelled and the value axis is
              dropped entirely. Keeping both would be the same number twice. The
              label wears the text token, not the bar's colour.
            */}
            <LabelList
              dataKey="count"
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

interface TierTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: TierDatum }>;
}

function TierTooltip({ active, payload }: TierTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 rounded-[2px]"
          style={{ backgroundColor: point.fill }}
        />
        <span className="text-xs font-medium text-foreground">{point.label}</span>
      </div>
      <p className="mt-1 pl-4 font-mono text-sm text-foreground">
        {formatCount(point.count)}
      </p>
      <p className="pl-4 text-xs text-muted-foreground">
        {formatPercent(point.share, 0)} of live subscriptions
      </p>
    </div>
  );
}
