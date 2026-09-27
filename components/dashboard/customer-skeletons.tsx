import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading shapes for the customers page.
 *
 * Shared by `app/(dashboard)/dashboard/customers/loading.tsx` and by each
 * `<Suspense>` boundary on the page itself, so there is exactly one definition of
 * what "still arriving" looks like and the layout does not reflow as sections
 * stream in. Same contract as `revenue-skeletons.tsx`.
 */

export function CustomerTilesSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-3">
          <CardContent className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-3.5 rounded" />
          </CardContent>
          <CardContent>
            <Skeleton className="h-7 w-20" />
          </CardContent>
          <CardContent className="flex items-center gap-2">
            <Skeleton className="h-5 w-12 rounded-4xl" />
            <Skeleton className="h-3 w-36" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function CustomerLedgerSkeleton() {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="hidden h-3.5 w-20 sm:block" />
            <Skeleton className="h-5 w-14 rounded-4xl" />
            <Skeleton className="hidden h-3.5 w-20 md:block" />
            <Skeleton className="hidden h-3.5 w-20 md:block" />
            <Skeleton className="ml-auto h-3.5 w-20" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** The whole content area, used by the route-segment loading fallback. */
export function CustomersSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-3.5 w-64" />
      </div>

      <div className="mt-3">
        <CustomerTilesSkeleton />
      </div>
      <CustomerLedgerSkeleton />
    </div>
  );
}
