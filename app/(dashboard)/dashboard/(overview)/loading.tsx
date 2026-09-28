// Segment loading fallback for /dashboard — the overview. Renders inside the
// shell, so it only skeletons the content — and it reuses the exact shapes the
// overview's own <Suspense> boundaries use, so nothing reflows when the real
// panels arrive.
//
// Why it lives in the `(overview)` route group rather than at `dashboard/`: a
// loading.tsx wraps its segment AND every route nested under it. At `dashboard/`
// (or the group root, where it used to be) it was an ancestor boundary of every
// other dashboard page, so a hard load of /dashboard/audit could flash the
// overview's silhouette before its own. Inside the group it wraps the overview
// page only; the URL is unchanged, because route groups do not appear in it.
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
