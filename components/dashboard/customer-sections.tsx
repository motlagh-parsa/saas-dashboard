import Link from "next/link";
import type { BillingInterval, PlanTier, SubscriptionStatus } from "@prisma/client";
import { Building2, TriangleAlert, UserCheck, UserMinus, Users, Wallet } from "lucide-react";

import { EM_DASH, formatCount, formatDay, formatEnumLabel, formatMoneyExact, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
 */

// ---------------------------------------------------------------------------
// View types — built by the page, rendered here
// ---------------------------------------------------------------------------

/**
 * Where a customer stands TODAY, decided by dates rather than `status` — see the
 * note at the top of lib/metrics.ts. The seed stamps `CANCELED` on every ended
 * segment, upgrades included, so `status` alone cannot tell churn from a plan change.
 *
 *   - `active`   — a segment is live now (`startedAt <= now < endedAt`).
 *   - `churned`  — nothing is live, and the last segment ended in a real
 *                  cancellation (`canceledAt` set).
 *   - `inactive` — nothing is live and there was no cancellation: never
 *                  subscribed, or not started yet.
 */
export type CustomerState = "active" | "churned" | "inactive";

export interface CustomerRow {
  readonly organizationId: string;
  readonly name: string;
  /** The live plan, or the last one for a customer with nothing live. Null if never subscribed. */
  readonly tier: PlanTier | null;
  readonly interval: BillingInterval | null;
  readonly state: CustomerState;
  /** Status of the live segment (Active / Trialing / Past due). Null unless `state` is "active". */
  readonly liveStatus: SubscriptionStatus | null;
  /** Monthly-normalized cents across live segments. 0 unless `state` is "active". */
  readonly mrrCents: number;
  readonly currency: string;
  /** Start of the first segment that has begun — the customer's first day. */
  readonly customerSince: Date | null;
  /** The cancellation that ended the last segment. Null unless `state` is "churned". */
  readonly canceledAt: Date | null;
}

export interface CustomersView {
  /** MRR descending, then name. */
  readonly customers: CustomerRow[];
  readonly activeCount: number;
  readonly churnedCount: number;
  /** Mean MRR over ACTIVE customers only — a churned customer's 0 is not a price point. */
  readonly averageMrrCents: number;
  /** ISO-4217 code of the most common currency among active customers. */
  readonly currency: string;
  readonly isMixedCurrency: boolean;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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
  customersPromise: Promise<CustomersView>;
}

export async function CustomerTiles({ customersPromise }: CustomerTilesProps) {
  const view = await customersPromise;
  const total = view.customers.length;
  const share = (count: number): string =>
    formatPercent(total === 0 ? null : count / total, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Customers"
          icon={Users}
          delta={<ScopeTag>All</ScopeTag>}
          footnote="Every workspace you belong to"
        >
          <CountUp value={total} format="count" />
        </MetricTile>

        <MetricTile
          label="Active"
          icon={UserCheck}
          delta={<ScopeTag>{share(view.activeCount)}</ScopeTag>}
          footnote="A plan is live today"
        >
          <CountUp value={view.activeCount} format="count" />
        </MetricTile>

        <MetricTile
          label="Churned"
          icon={UserMinus}
          delta={<ScopeTag>{share(view.churnedCount)}</ScopeTag>}
          footnote="Last plan cancelled, nothing live"
        >
          <CountUp value={view.churnedCount} format="count" />
        </MetricTile>

        <MetricTile
          label="Average MRR"
          icon={Wallet}
          delta={<ScopeTag>Active</ScopeTag>}
          footnote="Per active customer; yearly plans ÷ 12"
        >
          <CountUp value={view.averageMrrCents} format="money" currency={view.currency} />
        </MetricTile>
      </div>

      {view.isMixedCurrency ? (
        <p className="flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground text-balance">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
          <span>
            Active customers bill in more than one currency and no exchange rates are
            stored, so the average adds unlike amounts. Read it as an approximation.
          </span>
        </p>
      ) : null}
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
function statusBadge(customer: CustomerRow): StatusBadge {
  if (customer.state === "churned") {
    return { label: "Churned", className: "bg-negative/12 text-negative" };
  }
  if (customer.state === "inactive" || customer.liveStatus === null) {
    return { label: "No live plan", className: "bg-muted text-muted-foreground" };
  }
  switch (customer.liveStatus) {
    case "ACTIVE":
      return { label: "Active", className: "bg-positive/12 text-positive" };
    case "PAST_DUE":
      return { label: "Past due", className: "bg-brand/12 text-brand" };
    default:
      return {
        label: formatEnumLabel(customer.liveStatus),
        className: "bg-muted text-muted-foreground",
      };
  }
}

interface CustomerLedgerProps {
  customersPromise: Promise<CustomersView>;
}

export async function CustomerLedger({ customersPromise }: CustomerLedgerProps) {
  const { customers } = await customersPromise;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>All customers</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            One row per workspace, highest MRR first. A plan change continues a
            customer; only a cancellation with nothing live counts as churn.
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(customers.length)}{" "}
            {customers.length === 1 ? "customer" : "customers"}
          </span>
        </CardAction>
      </CardHeader>

      {customers.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Customers are the workspaces you belong to. Ask an owner to add you to theirs to see it here."
          action={
            <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
              <Link href="/dashboard/settings">Open workspace settings</Link>
            </Button>
          }
          className="mx-4 my-4 border-0 bg-transparent py-10"
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">
            Customers with their current plan, status, monthly recurring revenue, the
            date they started, and the date they cancelled if they have churned.
          </TableCaption>

          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className={cn(TABLE_HEAD, "pl-4")}>Customer</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>Plan</TableHead>
              <TableHead className={TABLE_HEAD}>Status</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>
                Customer since
              </TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>Canceled</TableHead>
              <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>MRR</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {customers.map((customer) => {
              const badge = statusBadge(customer);
              const plan = customer.tier === null ? EM_DASH : formatEnumLabel(customer.tier);

              return (
                <TableRow key={customer.organizationId} className="border-border">
                  <TableCell className="py-2.5 pl-4">
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="font-medium text-foreground">{customer.name}</span>
                      {/* Below `sm` the Plan column is gone, so it rides under the
                          name instead of being dropped. */}
                      <span className="font-mono text-[0.6875rem] text-muted-foreground sm:hidden">
                        {plan}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell className="hidden py-2.5 sm:table-cell">
                    {/* A churned customer's plan is history, not a live price, so it
                        drops to the muted voice. */}
                    <span
                      className={cn(
                        "font-medium",
                        customer.state === "active" ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {plan}
                    </span>
                    {customer.interval !== null ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {formatEnumLabel(customer.interval)}
                      </span>
                    ) : null}
                  </TableCell>

                  <TableCell className="py-2.5">
                    <Badge variant="secondary" className={cn("font-medium", badge.className)}>
                      {badge.label}
                    </Badge>
                  </TableCell>

                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                    {customer.customerSince === null ? EM_DASH : formatDay(customer.customerSince)}
                  </TableCell>

                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                    {customer.canceledAt === null ? EM_DASH : formatDay(customer.canceledAt)}
                  </TableCell>

                  <TableCell className="py-2.5 pr-4 text-right font-mono tabular-nums">
                    {customer.state === "active" ? (
                      <span className="text-foreground">
                        {formatMoneyExact(customer.mrrCents, customer.currency)}
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
