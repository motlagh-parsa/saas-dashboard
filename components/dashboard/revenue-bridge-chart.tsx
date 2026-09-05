"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoneyCompact } from "@/lib/format";
import {
  BRIDGE_HATCH_ID,
  BridgeSwatch,
  type BridgeDatum,
} from "@/components/dashboard/bridge-encoding";

interface RevenueBridgeChartProps {
  data: BridgeDatum[];
  currency: string;
}

/**
 * The revenue bridge: where MRR came from and where it went, month by month.
 *
 * Chart decisions worth stating:
 *   - ONE axis, zero-based. The balance columns are magnitudes measured from
 *     nothing, so a truncated axis would make them lie. MRR level and MRR
 *     movement are different scales and the movement chart never gets a second
 *     y-axis to make its bars look bigger.
 *   - A floating bar is a TRANSPARENT spacer stacked under the visible segment.
 *     The spacer is excluded from the tooltip (`tooltipType="none"`, and the
 *     tooltip reads the row rather than enumerating series) and from any legend
 *     (`legendType="none"`, and there is no <Legend> — identity is direct-labelled
 *     in HTML underneath, where it can wear text tokens).
 *   - Direction is encoded THREE ways: geometrically, since a bar rises or falls
 *     from the running baseline; by hue; and in the signed figures in the tooltip
 *     and the identity strip. Hue is the encoding a reader is most likely to lose,
 *     so it is never the only one.
 *   - Only the two endpoints are direct-labelled. A number over every column
 *     would print the y-axis twice.
 *   - `accessibilityLayer` is Recharts' keyboard layer: arrow keys walk the
 *     columns and surface the same tooltip the pointer does, so nothing here is
 *     gated behind hover.
 */
export function RevenueBridgeChart({ data, currency }: RevenueBridgeChartProps) {
  return (
    // The height includes the axis band, so the card never grows a nested scrollbar.
    <div className="h-72 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 22, right: 6, bottom: 0, left: 0 }}
          barCategoryGap="24%"
          accessibilityLayer
        >
          <defs>
            {/*
              The balance hatch. Totals are told apart from movement by MATERIAL,
              not by a third hue — no neutral survives the colour vision check
              against steel. Both tones are theme tokens, so light and dark are
              one implementation.
            */}
            <pattern
              id={BRIDGE_HATCH_ID}
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width={6} height={6} fill="var(--balance-fill)" />
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke="var(--balance-rule)"
                strokeWidth={1.5}
              />
            </pattern>
          </defs>

          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />

          <XAxis
            dataKey="tick"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            minTickGap={4}
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

          <Tooltip cursor={{ fill: "var(--accent)" }} content={<BridgeTooltip />} />

          {/*
            The spacer. It carries the distance from zero up to the foot of the
            visible segment and must never be seen, hovered or listed.
          */}
          <Bar
            dataKey="base"
            stackId="bridge"
            fill="transparent"
            stroke="none"
            maxBarSize={44}
            isAnimationActive={false}
            legendType="none"
            tooltipType="none"
          />

          <Bar
            dataKey="span"
            stackId="bridge"
            maxBarSize={44}
            legendType="none"
            animationDuration={700}
            animationEasing="ease-out"
          >
            {data.map((entry) => (
              <Cell key={entry.key} fill={entry.fill} />
            ))}
            {/*
              `labelText` is null on every column except the two balances, and
              Recharts renders nothing at all for a null value — so a zero-height
              or unlabelled column cannot leave a stray glyph behind.
            */}
            <LabelList
              dataKey="labelText"
              position="top"
              offset={8}
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

interface BridgeTooltipProps {
  /** Injected by Recharts when it clones this element. */
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: BridgeDatum }>;
}

/**
 * Values and labels wear text tokens; the small swatch carries identity. Every
 * figure in here was formatted on the server, so the tooltip does no arithmetic
 * and cannot disagree with the ledger strip below the chart.
 */
function BridgeTooltip({ active, payload }: BridgeTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="min-w-52 rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        {point.heading}
      </p>

      <div className="mt-1.5 flex items-center gap-2">
        <BridgeSwatch direction={point.direction} />
        <span className="font-mono text-sm text-foreground">{point.amount}</span>
      </div>

      {point.direction === "balance" ? null : (
        <p className="mt-0.5 pl-4 text-xs text-muted-foreground">
          Closes at <span className="font-mono text-foreground">{point.level}</span>
        </p>
      )}

      {point.components.length > 0 ? (
        <dl className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          {point.components.map((component) => (
            <div
              key={component.label}
              className="grid grid-cols-[0.75rem_1fr_auto] items-center gap-x-2 text-xs"
            >
              <span aria-hidden className="font-mono text-muted-foreground/70">
                {component.direction === "up" ? "+" : "−"}
              </span>
              <dt className="text-muted-foreground">{component.label}</dt>
              <dd className="text-right font-mono text-foreground tabular-nums">
                {component.amount}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {point.caption ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground text-balance">
          {point.caption}
        </p>
      ) : null}
    </div>
  );
}
