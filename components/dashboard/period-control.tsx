import Link from "next/link";

import { RANGE_OPTIONS, type RangeKey } from "@/lib/period";
import { cn } from "@/lib/utils";

interface PeriodControlProps {
  current: RangeKey;
  /**
   * Route the control links to. Defaults to the overview, so its existing call
   * site is unchanged; the revenue page points it at itself.
   */
  basePath?: string;
  /**
   * Query params to carry alongside `range`. Anything a page needs to preserve
   * across a period change — an invoice status filter, say — goes here. Anything
   * that must RESET on a period change (pagination cursors) is simply left out.
   */
  params?: Readonly<Record<string, string>>;
}

/**
 * The period control. It sets the window every period-over-period comparison is
 * measured against — not the MRR history, which is always twelve months and says
 * so on its own panel.
 *
 * Plain links over a client-side toggle: the state lives in the URL, so it is
 * shareable, back-button-correct, and needs no JavaScript to work.
 */
export function PeriodControl({
  current,
  basePath = "/dashboard",
  params,
}: PeriodControlProps) {
  const carried = params ? Object.entries(params) : [];

  return (
    <div
      role="group"
      aria-label="Comparison period"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const isActive = option.key === current;
        const query = new URLSearchParams({ range: option.key });
        for (const [key, value] of carried) query.set(key, value);

        return (
          <Link
            key={option.key}
            href={`${basePath}?${query.toString()}`}
            scroll={false}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              // 44px on touch, tightened to the data-density scale from md up.
              "inline-flex h-11 items-center rounded-md px-3 text-xs font-medium transition-colors md:h-8",
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
