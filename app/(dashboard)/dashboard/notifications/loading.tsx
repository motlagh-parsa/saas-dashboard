// Segment loading fallback for /dashboard/notifications.
//
// Without it the nearest boundary draws the OVERVIEW's silhouette — the wrong
// page. This mirrors NotificationPanel instead: the filter strip with its three
// chips and two actions, then the feed rows (read dot, type icon, title and
// body, a fixed-width timestamp column, and the reserved action slot).
//
// The shapes live here for the reason settings/loading.tsx gives: the page has
// no in-page `<Suspense>` boundaries, so this is the only consumer.
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = 8;

export default function NotificationsLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading notifications"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your notifications…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-3.5 w-48" />
        </div>

        <Card className="mt-3 gap-0 py-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            {/* Filter chips: All / Unread / Archived. */}
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <Skeleton className="h-11 w-12 md:h-8" />
              <Skeleton className="h-11 w-16 md:h-8" />
              <Skeleton className="h-11 w-20 md:h-8" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
              <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
            </div>
          </div>

          <div className="flex flex-col">
            {Array.from({ length: ROWS }).map((_, index) => (
              <div
                key={index}
                className="flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0"
              >
                <Skeleton className="mt-1.5 size-1.5 shrink-0 rounded-full" />
                <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-56 max-w-full" />
                  <Skeleton className="h-2.5 w-80 max-w-full" />
                </div>
                <Skeleton className="mt-0.5 h-2.5 w-[5.5rem] shrink-0" />
                <div className="w-[3.625rem] shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </main>
  );
}
