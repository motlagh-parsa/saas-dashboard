// Segment loading fallback for /dashboard/settings/profile.
//
// Without it the nearest boundary is settings/loading.tsx, which draws the
// WORKSPACE settings silhouette — the wrong page. Shapes live here for the
// reason that file gives: one consumer.
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProfileLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading profile"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your profile…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3.5 w-56" />
          </div>
          <Skeleton className="h-11 w-44 rounded-lg md:h-9" />
        </div>

        <Card className="mt-3">
          <CardHeader>
            <Skeleton className="h-3 w-20" />
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-2.5 w-56" />
            </div>
          </CardContent>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-11 w-full rounded-lg sm:h-9" />
                <Skeleton className="h-2.5 w-3/4" />
              </div>
            ))}
          </CardContent>
          <CardContent className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <Skeleton className="h-2.5 w-56" />
            <Skeleton className="h-11 w-32 rounded-lg sm:h-9" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="h-3 w-20" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-11 w-full rounded-lg sm:h-9" />
              </div>
            ))}
          </CardContent>
          <CardContent className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <Skeleton className="h-2.5 w-64" />
            <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
          </CardContent>
        </Card>

        {/* Notifications: one row per kind, with its two switches. */}
        <Card>
          <CardHeader>
            <Skeleton className="h-3 w-28" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-2.5 w-64" />
                </div>
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
