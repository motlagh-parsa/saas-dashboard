import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading shapes for the revenue page.
 *
 * Shared by `app/(dashboard)/dashboard/revenue/loading.tsx` and by each
 * `<Suspense>` boundary on the page itself, so there is exactly one definition of
 * what "still arriving" looks like and the layout does not reflow as sections
 * stream in.
 *
 * These are for a FIRST render only. Changing a filter or a period holds the
 * previous render on screen instead — a skeleton flash on refetch throws away
 * information the reader already had.
 */

/**
 * The skeleton reads as a BRIDGE, not as a bar chart: two anchors on the
 * baseline and floating columns between them. Getting the silhouette right is
 * what stops the layout jumping when the real chart replaces it.
 *
 * `items-end` aligns each item's margin box to the baseline, so the bottom
 * margin is what lifts a column off it.
 */
const BRIDGE_BARS: ReadonlyArray<readonly [string, string]> = [
  ["h-40", "mb-0"],
  ["h-4", "mb-40"],
  ["h-7", "mb-36"],
  ["h-3", "mb-44"],
  ["h-9", "mb-32"],
  ["h-5", "mb-40"],
  ["h-6", "mb-36"],
  ["h-4", "mb-40"],
  ["h-8", "mb-32"],
  ["h-3", "mb-40"],
  ["h-7", "mb-36"],
  ["h-5", "mb-40"],
  ["h-4", "mb-44"],
  ["h-44", "mb-0"],
];

export function BridgePanelSkeleton() {
  return (
    <Card className="h-full gap-5">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-16" />
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-11 w-48" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </CardContent>

      <CardContent>
        <div className="flex h-72 items-end gap-1.5 sm:h-80" aria-hidden>
          {BRIDGE_BARS.map(([height, offset], index) => (
            <Skeleton key={index} className={`flex-1 rounded-none ${height} ${offset}`} />
          ))}
        </div>
      </CardContent>

      <CardContent className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-20" />
      </CardContent>

      <CardContent className="border-t border-border pt-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-1.5 border-t-2 border-border pt-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function TrendPanelSkeleton() {
  return (
    <Card className="h-full gap-4">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-14" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-44 w-full rounded-md sm:h-52" />
      </CardContent>
      <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
        <Skeleton className="h-2.5 w-32" />
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-3/5" />
      </CardContent>
    </Card>
  );
}

export function RevenueTilesSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-3">
          <CardContent className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-3.5 rounded" />
          </CardContent>
          <CardContent>
            <Skeleton className="h-7 w-28" />
          </CardContent>
          <CardContent className="flex items-center gap-2">
            <Skeleton className="h-5 w-12 rounded-4xl" />
            <Skeleton className="h-3 w-40" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function InvoiceLedgerSkeleton() {
  return (
    <Card className="h-full gap-0 py-0">
      <div className="flex items-center justify-between px-4 py-3.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-40 rounded-lg" />
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <Skeleton className="h-2.5 w-72 max-w-full" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 border-t border-border px-4 py-3"
          >
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="hidden h-3.5 w-20 sm:block" />
            <Skeleton className="ml-auto h-3.5 w-20" />
            <Skeleton className="h-5 w-14 rounded-4xl" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
    </Card>
  );
}

/** The whole content area, used by the route-segment loading fallback. */
export function RevenueSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3.5 w-60" />
        </div>
        <Skeleton className="h-9 w-56 rounded-lg" />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.75fr_1fr]">
        <BridgePanelSkeleton />
        <TrendPanelSkeleton />
      </div>

      <RevenueTilesSkeleton />
      <InvoiceLedgerSkeleton />
    </div>
  );
}
