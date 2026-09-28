import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading shapes for the overview.
 *
 * Shared by `app/(dashboard)/loading.tsx` and by each `<Suspense>` boundary on
 * the page itself, so there is exactly one definition of what "still arriving"
 * looks like and the layout does not reflow as sections stream in.
 */

export function HeadlinePanelSkeleton() {
  return (
    <Card className="h-full gap-5">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-44" />
        <Skeleton className="h-5 w-16 rounded-4xl" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-11 w-56" />
        <Skeleton className="h-3 w-64" />
      </CardContent>
      <CardContent>
        <Skeleton className="h-56 w-full rounded-md sm:h-64" />
      </CardContent>
    </Card>
  );
}

export function RetentionLedgerSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader>
        <Skeleton className="h-3 w-40" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </CardContent>
      <CardContent className="flex flex-col gap-3.5 pt-1">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function KpiStripSkeleton() {
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
            <Skeleton className="h-5 w-16 rounded-4xl" />
            <Skeleton className="h-3 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function UserActivityStripSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: 2 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-3">
          <CardContent className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-3.5 rounded" />
          </CardContent>
          <CardContent>
            <Skeleton className="h-7 w-20" />
          </CardContent>
          <CardContent className="flex items-center gap-2">
            <Skeleton className="h-5 w-16 rounded-4xl" />
            <Skeleton className="h-3 w-40" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function PlanMixSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader className="flex items-center justify-between">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-3 w-16" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 py-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-3 w-20 shrink-0" />
            <Skeleton className="h-3.5 w-full min-w-0 flex-1 rounded-sm" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function InvoicesSkeleton() {
  return (
    <Card className="h-full gap-0 py-0">
      <div className="flex items-center justify-between px-4 py-4">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 6 }).map((_, index) => (
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
    </Card>
  );
}

/** The whole content area, used by the route-group loading fallback. */
export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-3.5 w-60" />
        </div>
        <Skeleton className="h-9 w-56 rounded-lg" />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.7fr_1fr]">
        <HeadlinePanelSkeleton />
        <RetentionLedgerSkeleton />
      </div>

      <KpiStripSkeleton />
      <UserActivityStripSkeleton />

      <div className="grid gap-3 xl:grid-cols-[1fr_1.6fr]">
        <PlanMixSkeleton />
        <InvoicesSkeleton />
      </div>
    </div>
  );
}
