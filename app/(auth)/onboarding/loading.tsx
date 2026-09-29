// Loading fallback for /onboarding: the step header and the cards' silhouette,
// inside the same brand shell.
import { Skeleton } from "@/components/ui/skeleton";

export default function OnboardingLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading setup" className="w-full max-w-2xl">
      <span className="sr-only">Loading your setup…</span>
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-6 h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    </div>
  );
}
