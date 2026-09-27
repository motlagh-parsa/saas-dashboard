// Segment loading fallback for /dashboard/customers.
//
// The (dashboard) group already has one, but it renders the OVERVIEW's shapes —
// arriving on this route would flash a layout that is not the one about to
// appear. This overrides it with the customers silhouette, so the only thing that
// changes when the data lands is the content.
import { CustomersSkeleton } from "@/components/dashboard/customer-skeletons";

export default function CustomersLoading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading customers"
      className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
    >
      <span className="sr-only">Loading your customers…</span>
      <CustomersSkeleton />
    </main>
  );
}
