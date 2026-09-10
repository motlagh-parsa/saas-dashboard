import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading shapes for the retention page.
 *
 * Shared by `app/(dashboard)/dashboard/retention/loading.tsx` and by each
 * `<Suspense>` boundary on the page itself, so there is exactly one definition of
 * what "still arriving" looks like and the layout does not reflow as sections
 * stream in.
 *
 * These are for a FIRST render only. Changing the period holds the previous
 * render on screen instead — a skeleton flash on refetch throws away information
 * the reader already had.
 */

export function RetentionTilesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <Card key={index} size="sm" className="gap-3">
            <CardContent className="flex items-center justify-between">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="size-3.5 rounded" />
            </CardContent>
            <CardContent className="flex flex-col gap-3">
              {/* The first tile carries the larger figure and the brass rule. */}
              <Skeleton className={index === 0 ? "h-8 w-32" : "h-7 w-24"} />
              {index === 0 ? <Skeleton className="h-px w-12" /> : null}
            </CardContent>
            <CardContent className="flex items-center gap-2">
              <Skeleton className="h-5 w-16 rounded-4xl" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-2.5 w-full max-w-3xl" />
    </div>
  );
}

/**
 * Both trend panels share one silhouette on purpose — they share one on screen
 * too, which is what makes the two series comparable by eye.
 */
function TrendPanelSkeleton() {
  return (
    <Card className="h-full gap-4">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-16" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-44 w-full rounded-md sm:h-52" />
      </CardContent>
      <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
        <Skeleton className="h-2.5 w-40" />
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-3/5" />
      </CardContent>
    </Card>
  );
}

export function NrrTrendPanelSkeleton() {
  return <TrendPanelSkeleton />;
}

export function ChurnTrendPanelSkeleton() {
  return <TrendPanelSkeleton />;
}

export function MovementSectionSkeleton() {
  return (
    <Card className="h-full gap-4">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-44" />
        <Skeleton className="h-5 w-16 rounded-4xl" />
      </CardHeader>

      <CardContent>
        <Skeleton className="h-2.5 w-full max-w-2xl" />
      </CardContent>

      <CardContent className="grid gap-x-10 gap-y-5 md:grid-cols-2">
        {/* Four rows then a rule on the left, three then a rule on the right —
            the same asymmetry the real ledger has, so nothing shifts when it
            lands. */}
        {[4, 3].map((rows, column) => (
          <div key={column} className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-16" />
            {Array.from({ length: rows }).map((_, row) => (
              <div key={row} className="flex items-center justify-between gap-4 py-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-border pt-2.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="mt-1.5 ml-4 h-2.5 w-4/5" />
          </div>
        ))}
      </CardContent>

      <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
        <Skeleton className="h-2.5 w-40" />
        <Skeleton className="h-2.5 w-full" />
      </CardContent>
    </Card>
  );
}

/** The whole content area, used by the route-segment loading fallback. */
export function RetentionSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-3.5 w-60" />
        </div>
        <Skeleton className="h-9 w-56 rounded-lg" />
      </div>

      <div className="mt-3">
        <RetentionTilesSkeleton />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <NrrTrendPanelSkeleton />
        <ChurnTrendPanelSkeleton />
      </div>

      <MovementSectionSkeleton />
    </div>
  );
}
