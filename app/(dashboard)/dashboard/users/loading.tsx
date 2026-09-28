// Segment loading fallback for /dashboard/users.
//
// The (dashboard) group already has one, but it renders the OVERVIEW's shapes —
// arriving on this route would flash a layout that is not the one about to
// appear. This overrides it with the users silhouette.
//
// The shapes live here rather than in a `users-skeletons.tsx` for the reason
// settings/loading.tsx gives: the page has no in-page `<Suspense>` boundaries,
// so this is the only consumer.
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = 8;

export default function UsersLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading users"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading the people in your workspace…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3.5 w-52" />
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Skeleton className="h-11 w-full rounded-lg sm:h-9 sm:w-72" />
            <Skeleton className="h-11 w-28 shrink-0 rounded-lg sm:h-9" />
          </div>
        </div>

        <Card className="mt-3 gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-2.5 w-80 max-w-full" />
            </div>
            <CardAction>
              <Skeleton className="h-3 w-16" />
            </CardAction>
          </CardHeader>

          <div className="flex flex-col">
            {Array.from({ length: ROWS }).map((_, index) => (
              <div
                key={index}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-6 rounded-full" />
                  <Skeleton className="h-3.5 w-32" />
                </div>
                <Skeleton className="hidden h-3 w-48 md:block" />
                <Skeleton className="h-5 w-14 rounded-4xl" />
                <Skeleton className="hidden h-3 w-20 sm:block" />
                <Skeleton className="h-5 w-14 rounded-4xl" />
                <Skeleton className="ml-auto h-11 w-40 rounded-lg sm:h-8" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </main>
  );
}
