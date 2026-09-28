import { TriangleAlert, UserCheck, UserMinus, UserPlus, Users, Wallet } from "lucide-react";

import type { CustomerListResult, CustomerListRow } from "@/lib/metrics";
import { EM_DASH, formatCount, formatDay, formatMoneyExact, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CountUp } from "@/components/dashboard/count-up";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricTile } from "@/components/dashboard/metric-tile";

/**
 * The customers page's data-owning sections.
 *
 * Both sections await the SAME promise — the page runs one query — but each sits
 * in its own `<Suspense>` and error boundary, so the shell paints first and a
 * failure is contained to the section that shows it, same as the revenue page.
 *
 * A customer is a `Customer` row of the active workspace; where they stand
 * (active / churned / inactive) is derived from their subscriptions' dates in
 * lib/metrics.ts, never stored.
 */

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

/** Column headers wear the same mono caps as every other register in the app. */
const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

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

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface StatusBadge {
  readonly label: string;
  readonly className: string;
}

/**
 * Status is state, so it is the one column where the semantic colours are
 * allowed — same rule as the invoice ledger. Past due borrows the invoice
 * ledger's OPEN treatment: money owed, not yet lost.
 */
function statusBadge(customer: CustomerListRow): StatusBadge {
  if (customer.state === "churned") {
    return { label: "Churned", className: "bg-negative/12 text-negative" };
  }
  if (customer.state === "inactive") {
    return { label: "Not paying yet", className: "bg-muted text-muted-foreground" };
  }
  if (customer.pastDue) {
    return { label: "Past due", className: "bg-brand/12 text-brand" };
  }
  return { label: "Active", className: "bg-positive/12 text-positive" };
}

interface CustomerLedgerProps {
  customersPromise: Promise<CustomerListResult>;
}

export async function CustomerLedger({ customersPromise }: CustomerLedgerProps) {
  const { customers, currency } = await customersPromise;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>All customers</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            Highest MRR first. A plan change keeps a customer; only stopping paying
            counts as churn.
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(customers.length)} {customers.length === 1 ? "customer" : "customers"}
          </span>
        </CardAction>
      </CardHeader>

      {customers.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No customers yet"
          description="Customers appear here as soon as the first subscription is added. Add one from the Revenue page."
          className="mx-4 my-4 border-0 bg-transparent py-10"
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">
            Customers with their current plans, status, monthly recurring revenue, the
            date they first paid, and the date they stopped if they have churned.
          </TableCaption>

          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className={cn(TABLE_HEAD, "pl-4")}>Customer</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>Plan</TableHead>
              <TableHead className={TABLE_HEAD}>Status</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>
                Customer since
              </TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>Churned</TableHead>
              <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>MRR</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {customers.map((customer) => {
              const badge = statusBadge(customer);
              const plan = customer.livePlans ?? EM_DASH;

              return (
                <TableRow key={customer.id} className="border-border">
                  <TableCell className="py-2.5 pl-4">
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate font-medium text-foreground">{customer.name}</span>
                      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {customer.email ?? EM_DASH}
                      </span>
                      {/* Below `sm` the Plan column is gone, so it rides under the
                          name instead of being dropped. */}
                      <span className="truncate text-[0.6875rem] text-muted-foreground sm:hidden">
                        {plan}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell className="hidden py-2.5 sm:table-cell">
                    <span
                      className={cn(
                        "font-medium",
                        customer.state === "active" ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {plan}
                    </span>
                  </TableCell>

                  <TableCell className="py-2.5">
                    <Badge variant="secondary" className={cn("font-medium", badge.className)}>
                      {customer.pastDue ? (
                        <TriangleAlert aria-hidden className="size-3" />
                      ) : null}
                      {badge.label}
                    </Badge>
                  </TableCell>

                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                    {customer.customerSince === null ? EM_DASH : formatDay(customer.customerSince)}
                  </TableCell>

                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                    {customer.churnedAt === null ? EM_DASH : formatDay(customer.churnedAt)}
                  </TableCell>

                  <TableCell className="py-2.5 pr-4 text-right font-mono tabular-nums">
                    {customer.state === "active" ? (
                      <span className="text-foreground">
                        {formatMoneyExact(customer.mrrCents, currency)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{EM_DASH}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
