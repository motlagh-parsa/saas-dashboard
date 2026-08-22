import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatPoints, formatSignedPercent } from "@/lib/format";

interface DeltaBadgeProps {
  /**
   * A FRACTION. `changePct` for "percent" (0.12 = +12%), `changePoints` for
   * "points" (0.021 = +2.1pp). `null` means there was no previous value to
   * compare against, which is a state, not a zero.
   */
  value: number | null;
  unit: "percent" | "points";
  /**
   * Which direction is a good outcome. Colour follows MEANING, not sign: MRR
   * rising is emerald, churn rising is rose, and both are "+".
   */
  goodDirection: "up" | "down";
  className?: string;
}

const TONE_CLASS = {
  good: "bg-positive/12 text-positive",
  bad: "bg-negative/12 text-negative",
  flat: "bg-muted text-muted-foreground",
} as const;

export function DeltaBadge({ value, unit, goodDirection, className }: DeltaBadgeProps) {
  if (value === null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No prior period
      </span>
    );
  }

  // Compare at the precision we actually print, so a rendered "+0.0%" is never
  // coloured as growth.
  const printed = Math.round(value * 1000) / 10;
  const rising = printed > 0;
  const tone =
    printed === 0 ? "flat" : rising === (goodDirection === "up") ? "good" : "bad";

  const Icon = printed === 0 ? Minus : rising ? ArrowUpRight : ArrowDownRight;
  const label = unit === "percent" ? formatSignedPercent(value) : formatPoints(value);

  return (
    <Badge
      variant="secondary"
      className={cn("gap-0.5 pl-1 font-mono text-[0.6875rem]", TONE_CLASS[tone], className)}
    >
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
