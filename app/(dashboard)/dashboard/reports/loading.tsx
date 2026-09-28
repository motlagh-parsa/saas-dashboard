// Segment loading fallback for /dashboard/reports.
//
// Without it the nearest boundary draws the OVERVIEW's silhouette — the wrong
// page. This mirrors the reports page instead: the header with its Schedule
// button, the four equal catalogue cards, then the "Recent exports" register.
//
// The shapes live here for the reason settings/loading.tsx gives: the page has
// no in-page `<Suspense>` boundaries, so this is the only consumer.
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const CATALOGUE_CARDS = 4;
const REGISTER_ROWS = 5;

export default function ReportsLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading reports"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your reports…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="h-11 w-40 rounded-lg sm:h-9" />
        </div>

        {/* The catalogue: four equal cards, like the page. */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: CATALOGUE_CARDS }).map((_, index) => (
            <Card key={index} size="sm" className="h-full gap-2.5">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Skeleton className="size-3.5 rounded" />
                  <Skeleton className="h-3.5 w-28" />
                </div>
                <CardAction>
                  <Skeleton className="h-11 w-20 rounded-lg sm:h-8" />
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="h-2.5 w-4/5" />
              </CardContent>
              <CardFooter className="mt-auto justify-between gap-2">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-2.5 w-16" />
              </CardFooter>
            </Card>
          ))}
        </div>

        {/* Recent exports register: header row plus five runs. */}
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-64" />
            </div>
            <CardAction>
              <Skeleton className="h-3 w-16" />
            </CardAction>
          </CardHeader>

          <div className="flex items-center gap-4 border-b border-border px-4 py-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="hidden h-2.5 w-14 sm:block" />
            <Skeleton className="hidden h-2.5 w-14 sm:block" />
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="ml-auto h-2.5 w-16" />
          </div>

          <div className="flex flex-col">
            {Array.from({ length: REGISTER_ROWS }).map((_, index) => (
              <div
                key={index}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="hidden h-3 w-24 sm:block" />
                <Skeleton className="hidden h-3 w-10 sm:block" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="ml-auto h-11 w-24 rounded-lg sm:h-8" />
              </div>
            ))}
          </div>

          <CardFooter>
            <Skeleton className="h-2.5 w-72 max-w-full" />
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
