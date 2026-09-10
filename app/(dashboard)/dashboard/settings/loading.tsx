// Segment loading fallback for /dashboard/settings.
//
// The (dashboard) group already has one, but it renders the OVERVIEW's shapes —
// arriving on this route would flash a layout that is not the one about to
// appear. This overrides it with the settings silhouette, so the only thing that
// changes when the data lands is the content.
//
// The shapes live here rather than in `components/dashboard/settings-skeletons.tsx`
// on purpose. The other pages extract theirs because a skeleton is shared between
// this file AND each `<Suspense>` boundary on the page, and one definition is what
// keeps them from drifting. Settings has no in-page boundaries — one dependent
// query chain, no streaming — so there is exactly one consumer, and a module with
// one consumer is indirection, not structure.
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the two-up field grid and its footer rule. */
function WorkspaceSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-3 w-24" />
      </CardHeader>

      <CardContent className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-lg" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-2.5 w-64" />
        </div>
      </CardContent>

      <CardContent className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className="h-11 w-full rounded-lg sm:h-9" />
            <Skeleton className="h-2.5 w-4/5" />
          </div>
        ))}
      </CardContent>

      <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <Skeleton className="h-2.5 w-56" />
        <Skeleton className="h-11 w-32 rounded-lg sm:h-9" />
      </CardContent>
    </Card>
  );
}

/**
 * Three member rows. The real list is whatever the workspace holds, but a
 * fallback has to pick a height, and three is the seeded shape — close enough
 * that the card does not jump when the true count arrives.
 */
function MembersSkeleton() {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-2.5 w-64" />
        </div>
        {/* A real `CardAction`, not a skeleton positioned to look like one:
            `CardHeader`'s two-column grid only engages when a child actually
            carries `data-slot="card-action"`. */}
        <CardAction>
          <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
        </CardAction>
      </CardHeader>

      <div className="flex flex-col">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="hidden h-3 w-48 sm:block" />
            <Skeleton className="h-5 w-16 rounded-4xl" />
          </div>
        ))}
      </div>
    </Card>
  );
}

function DangerZoneSkeleton() {
  return (
    <Card className="ring-destructive/25">
      <CardHeader>
        <Skeleton className="h-3 w-24" />
      </CardHeader>

      <CardContent className="flex flex-col">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0"
          >
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="h-2.5 w-72" />
            </div>
            <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SettingsLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading settings"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your workspace settings…</span>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-3.5 w-52" />
        </div>

        <div className="mt-3">
          <WorkspaceSkeleton />
        </div>

        <MembersSkeleton />
        <DangerZoneSkeleton />
      </div>
    </main>
  );
}
