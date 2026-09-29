// Segment loading fallback for /dashboard/import.
//
// Overrides the (dashboard) group's overview-shaped fallback with this page's
// own silhouette, so the only thing that changes when the data lands is the
// content — the customers page's reasoning.
import { TablePageSkeleton } from "@/components/billing/billing-skeletons";

export default function ImportLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading import"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading import…</span>
      <TablePageSkeleton />
    </main>
  );
}
