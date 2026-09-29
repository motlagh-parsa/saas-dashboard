// The sidebar's metrics freshness line, for the ACTIVE workspace: "Up to date"
// when its latest snapshot is today (UTC), "Last updated yesterday / N days ago"
// otherwise — the daily cron has not caught up — and nothing at all when the
// workspace has no subscriptions, so there is nothing to be up to date about.
import { cn } from "@/lib/utils";

const DAY_MS = 86_400_000;

interface MetricsStatusProps {
  /** Latest stored snapshot day, or null when none has been written yet. */
  latestSnapshot: Date | null;
  hasSubscriptions: boolean;
  now?: Date;
}

function describe(latest: Date | null, now: Date): { label: string; fresh: boolean } {
  if (latest === null) return { label: "Metrics not calculated yet", fresh: false };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((today - latest.getTime()) / DAY_MS);
  if (days <= 0) return { label: "Up to date", fresh: true };
  return { label: `Last updated ${days === 1 ? "yesterday" : `${days} days ago`}`, fresh: false };
}

export function MetricsStatus({ latestSnapshot, hasSubscriptions, now = new Date() }: MetricsStatusProps) {
  if (!hasSubscriptions) return null;
  const { label, fresh } = describe(latestSnapshot, now);
  return (
    <div
      data-testid="metrics-status"
      className="mt-auto flex items-center gap-2 rounded-md border border-sidebar-border/70 px-2.5 py-2"
    >
      <span className="relative flex size-2 shrink-0">
        <span className={cn("absolute inline-flex size-full rounded-full", fresh ? "bg-positive/70" : "bg-brand/60")} />
        <span className={cn("relative inline-flex size-2 rounded-full", fresh ? "bg-positive" : "bg-brand")} />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
