// Segment loading fallback for /dashboard/retention.
//
// The (dashboard) group already has one, but it renders the OVERVIEW's shapes —
// arriving on this route would flash a layout that is not the one about to
// appear. This overrides it with the retention silhouette, so the only thing that
// changes when the data lands is the content.
import { RetentionSkeleton } from "@/components/dashboard/retention-skeletons";

export default function RetentionLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading retention"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your retention figures…</span>
      <RetentionSkeleton />
    </main>
  );
}
