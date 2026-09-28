import { UserCheck, UserMinus, Users, Wallet } from "lucide-react";

import type { CustomerListResult } from "@/lib/metrics";
import { formatCount, formatPercent } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { CountUp } from "@/components/dashboard/count-up";
import { MetricTile } from "@/components/dashboard/metric-tile";

/**
 * The customers page's totals tiles, streamed in their own `<Suspense>` and
 * error boundary. The table beside them is components/billing/customers-table.tsx.
 *
 * A customer is a `Customer` row of the active workspace; where they stand
 * (active / churned / inactive) is derived from their subscriptions' dates in
 * lib/metrics.ts, never stored.
 */

/** Same treatment as the revenue tiles' scope tags. */
function ScopeTag({ children }: { children: string }) {
  return (
    <Badge
      variant="secondary"
      className="bg-muted font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase"
    >
      {children}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

interface CustomerTilesProps {
  customersPromise: Promise<CustomerListResult>;
}

export async function CustomerTiles({ customersPromise }: CustomerTilesProps) {
  const view = await customersPromise;
  const total = view.customers.length;
  const share = (count: number): string => formatPercent(total === 0 ? null : count / total, 0);
  const neverPaid = total - view.activeCount - view.churnedCount;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricTile
        label="Customers"
        icon={Users}
        delta={<ScopeTag>All</ScopeTag>}
        footnote={
          neverPaid > 0
            ? `${formatCount(neverPaid)} not paying yet`
            : "Everyone who has ever subscribed"
        }
      >
        <CountUp value={total} format="count" />
      </MetricTile>

      <MetricTile
        label="Active"
        icon={UserCheck}
        delta={<ScopeTag>{share(view.activeCount)}</ScopeTag>}
        footnote="Paying today"
      >
        <CountUp value={view.activeCount} format="count" />
      </MetricTile>

      <MetricTile
        label="Churned"
        icon={UserMinus}
        delta={<ScopeTag>{share(view.churnedCount)}</ScopeTag>}
        footnote="Paid before, not paying today"
      >
        <CountUp value={view.churnedCount} format="count" />
      </MetricTile>

      <MetricTile
        label="Average MRR"
        icon={Wallet}
        delta={<ScopeTag>Active</ScopeTag>}
        footnote="Per paying customer (ARPA)"
      >
        <CountUp value={view.averageMRRCents} format="money" currency={view.currency} />
      </MetricTile>
    </div>
  );
}
