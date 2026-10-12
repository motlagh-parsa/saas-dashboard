// Segment loading fallback for /dashboard/settings/integrations — its own
// silhouette, for the reason settings/profile/loading.tsx gives.
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function IntegrationsLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading integrations"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading integrations…</span>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Skeleton className="h-11 w-60 rounded-lg md:h-9" />
        </div>
        <Card className="mt-3 gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-2.5 w-80 max-w-full" />
              <Skeleton className="h-2.5 w-24" />
            </div>
            <CardAction>
              <Skeleton className="h-11 w-32 rounded-lg sm:h-9" />
            </CardAction>
          </CardHeader>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-2.5 w-24" />
              </div>
              <Skeleton className="hidden h-3 w-24 sm:block" />
              <Skeleton className="h-5 w-16 rounded-4xl" />
            </div>
          ))}
        </Card>
      </div>
    </main>
  );
}
