import type { ComponentType, ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricTileProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** The figure. Usually a `<CountUp />`. */
  children: ReactNode;
  /** A `<DeltaBadge />`, or whatever states the comparison. */
  delta: ReactNode;
  /** What the delta is measured against, or how the figure is derived. */
  footnote: string;
  className?: string;
}

/**
 * A subordinate KPI. Deliberately quieter than the headline panel: smaller
 * figure, no chart, no colour beyond the delta. Four equal-weight tiles would
 * tell the reader that four numbers matter equally, and they do not.
 *
 * It also has no hover state on purpose. Nothing in here is clickable, and a
 * card that lights up under the cursor promises an interaction that does not
 * exist. Hover belongs to things that respond: chart marks, table rows, the
 * period control.
 */
export function MetricTile({
  label,
  icon: Icon,
  children,
  delta,
  footnote,
  className,
}: MetricTileProps) {
  return (
    <Card size="sm" className={cn("gap-3", className)}>
      <CardContent className="flex items-center justify-between gap-2">
        <span className="font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {label}
        </span>
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
      </CardContent>

      <CardContent>
        <p className="font-mono text-2xl tracking-[-0.02em] text-foreground tabular-nums">
          {children}
        </p>
      </CardContent>

      <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {delta}
        <span className="text-xs text-muted-foreground">{footnote}</span>
      </CardContent>
    </Card>
  );
}
