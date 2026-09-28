// Segment loading fallback for /dashboard/audit.
//
// Overrides the (dashboard) group's overview-shaped fallback with the audit
// log's silhouette. The shapes live here rather than in an `audit-skeletons.tsx`
// for the reason settings/loading.tsx gives: the page has no in-page
// `<Suspense>` boundaries, so this is the only consumer.
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = 10;

export default function AuditLogLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading audit log"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading the audit log…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3.5 w-52" />
        </div>

        <Card className="mt-3 gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2.5 w-80 max-w-full" />
            </div>
            <CardAction>
              <Skeleton className="h-3 w-20" />
            </CardAction>
          </CardHeader>

          <div className="flex flex-col">
            {Array.from({ length: ROWS }).map((_, index) => (
              <div
                key={index}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 w-28" />
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-2.5 w-12" />
                </div>
                <Skeleton className="hidden h-3 w-40 md:block" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </main>
  );
}
