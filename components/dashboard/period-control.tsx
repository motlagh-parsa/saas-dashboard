import Link from "next/link";

import { RANGE_OPTIONS, type RangeKey } from "@/lib/period";
import { cn } from "@/lib/utils";

interface PeriodControlProps {
  current: RangeKey;
}

/**
 * The one control on the overview. It sets the window every period-over-period
 * comparison is measured against — not the MRR history, which is always twelve
 * months and says so on its own panel.
 *
 * Plain links over a client-side toggle: the state lives in the URL, so it is
 * shareable, back-button-correct, and needs no JavaScript to work.
 */
export function PeriodControl({ current }: PeriodControlProps) {
  return (
    <div
      role="group"
      aria-label="Comparison period"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const isActive = option.key === current;
        return (
          <Link
            key={option.key}
            href={`/dashboard?range=${option.key}`}
            scroll={false}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "inline-flex h-10 items-center rounded-md px-3 text-xs font-medium transition-colors md:h-8",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              isActive
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}
