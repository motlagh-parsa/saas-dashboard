// Route-group loading fallback for the (dashboard) segment. Renders inside the
// shell, so it only skeletons the content — and it reuses the exact shapes the
// overview's own <Suspense> boundaries use, so nothing reflows when the real
// panels arrive.
import { OverviewSkeleton } from "@/components/dashboard/overview-skeletons";

export default function DashboardLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading overview"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your metrics…</span>
      <OverviewSkeleton />
    </main>
  );
}
