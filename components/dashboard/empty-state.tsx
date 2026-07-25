import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** Primary/secondary actions — an empty screen is an invitation to act. */
  action?: ReactNode;
  className?: string;
};

/**
 * First-run and no-data screens. Presentational and reusable — the dashboard
 * page (owned by nextjs-architect) can drop this in for its empty state.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="grid size-11 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
          <Icon className="size-5" />
        </span>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="font-heading text-base font-semibold tracking-tight">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground text-balance">{description}</p>
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}