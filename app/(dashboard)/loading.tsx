// Route-group loading fallback for the (dashboard) segment. Renders inside the
// shell, so it only skeletons the content — and it mirrors the real hierarchy:
// one dominant metric marquee, a subordinate KPI strip, a chart, then a table.
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading overview"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your metrics…</span>

      {/* Page heading + range control */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="h-8 w-52 rounded-md" />
      </div>

      {/* Hero marquee — the single most important number */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-6 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-12 w-56" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
        <div className="hidden flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10 lg:flex">
          <Skeleton className="h-3.5 w-24" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-14" />
            </div>
          ))}
        </div>
      </div>

      {/* Subordinate KPI strip */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="size-4 rounded" />
            </div>
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Chart + table */}
      <div className="mt-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3.5 w-24" />
        </div>
        <Skeleton className="mt-5 h-64 w-full rounded-md" />
      </div>

      <div className="mt-4 rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex items-center justify-between p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="flex flex-col">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-t border-border px-4 py-3"
            >
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="ml-auto h-3.5 w-20" />
              <Skeleton className="hidden h-3.5 w-16 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}