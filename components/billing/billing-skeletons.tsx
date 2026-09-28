import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomerLedgerSkeleton, CustomerTilesSkeleton } from "@/components/dashboard/customer-skeletons";

/**
 * Loading shapes for the billing pages — plans, invoices, one customer — built
 * from the customers page's own skeleton parts, so every table page loads with
 * the same silhouette it will land in.
 */

function HeaderSkeleton() {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-3.5 w-64" />
      </div>
      <Skeleton className="h-9 w-32" />
    </div>
  );
}

/** A header and one data table: the plans and invoices pages. */
export function TablePageSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <HeaderSkeleton />
      <div className="mt-3">
        <CustomerLedgerSkeleton />
      </div>
    </div>
  );
}

/** One customer: header, four tiles, a subscription timeline, invoices. */
export function CustomerDetailSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-3 w-20" />
      <HeaderSkeleton />
      <div className="mt-2">
        <CustomerTilesSkeleton />
      </div>
      <Skeleton className="mt-3 h-3 w-28" />
      <Card className="gap-0 py-0">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-56 max-w-full" />
              <Skeleton className="h-2.5 w-40" />
            </div>
            <Skeleton className="h-5 w-20 rounded-4xl" />
          </div>
        ))}
      </Card>
      <CustomerLedgerSkeleton />
    </div>
  );
}
