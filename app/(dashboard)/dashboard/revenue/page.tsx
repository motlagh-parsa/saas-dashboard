// The revenue page. Render mode: dynamic — it reads the session cookie and query
// params, so it is never statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. Every untrusted query param is narrowed before it reaches a query: the
//      period through `parseRange`, the invoice status through a fixed whitelist,
//      and the pagination cursor through a strict codec.
//   4. Every query is started at once and handed to a section as a promise, so
//      the round trips overlap and each section streams into its own `<Suspense>`
//      boundary rather than the page blocking on the slowest one.
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getInvoiceTotals,
  getInvoices,
  getMRRTrend,
  getMetricsSummary,
  getRevenueMovement,
  resolvePeriod,
} from "@/lib/metrics";
import { formatDay } from "@/lib/format";
import { parseRange, periodFor } from "@/lib/period";
import {
  decodeCursor,
  parseCursorStack,
  parseStatusFilter,
  statusFilterOption,
} from "@/lib/invoice-filter";
import { Button } from "@/components/ui/button";
import { AddSubscriptionDialog } from "@/components/dashboard/add-subscription-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PeriodControl } from "@/components/dashboard/period-control";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import {
  BridgePanel,
  InvoiceLedger,
  RevenueTiles,
  TrendPanel,
} from "@/components/dashboard/revenue-sections";
import {
  BridgePanelSkeleton,
  InvoiceLedgerSkeleton,
  RevenueTilesSkeleton,
  TrendPanelSkeleton,
} from "@/components/dashboard/revenue-skeletons";

export const metadata: Metadata = {
  title: "Revenue",
  description: "The MRR bridge, collections, and invoice history for your workspace.",
};

/** Months of history in the bridge and the trend. Both windows, one number. */
const HISTORY_MONTHS = 12;

/** Rows per page in the invoice ledger. */
const INVOICES_PER_PAGE = 12;

interface RevenuePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Starts a query immediately and marks it handled.
 *
 * Attaching a no-op rejection handler stops Node from reporting an unhandled
 * rejection during the gap between "query launched" and "some suspended section
 * finally awaits it". The original promise still rejects for whoever awaits it,
 * which is exactly what routes a failure to that section's error boundary.
 */
function eager<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

export default async function RevenuePage({ searchParams }: RevenuePageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const range = parseRange(params.range);
  const period = periodFor(range);
  const asOf = resolvePeriod(period).end;

  const status = parseStatusFilter(params.status);
  const statusOption = statusFilterOption(status);

  // Forward-only keyset paging, with the history of pages already visited kept in
  // the URL. Anything malformed collapses to page one rather than erroring.
  const cursors = parseCursorStack(params.cursors);
  const lastToken = cursors.length > 0 ? cursors[cursors.length - 1] : null;
  const cursor = lastToken === null ? undefined : (decodeCursor(lastToken) ?? undefined);

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Revenue is scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking billing."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/dashboard/settings">Open workspace settings</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  // The header names the workspace, and the caller's role there decides whether
  // "Add subscription" is offered — one row, by composite key.
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true, organization: { select: { name: true } } },
  });
  const organization = membership.organization;
  // The action re-checks this; members are simply not offered a control that
  // would refuse them.
  const canAddSubscription = membership.role !== "MEMBER";

  const summaryPromise = eager(getMetricsSummary(organizationId, period));
  const movementPromise = eager(getRevenueMovement(organizationId, HISTORY_MONTHS));
  const trendPromise = eager(getMRRTrend(organizationId, HISTORY_MONTHS));
  const totalsPromise = eager(getInvoiceTotals(organizationId, period));
  const invoicesPromise = eager(
    getInvoices(organizationId, {
      limit: INVOICES_PER_PAGE,
      statuses: statusOption.statuses,
      cursor,
    }),
  );

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Revenue</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {organization.name}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            figures through {formatDay(asOf)}
          </p>
        </div>
        {/*
          The period scopes the billing tiles. It carries the status filter with
          it and deliberately drops the cursor stack: a new period is a new result
          set, and a cursor from the old one would point at nothing.
        */}
        <div className="flex flex-wrap items-center gap-2">
          {canAddSubscription ? <AddSubscriptionDialog organizationId={organizationId} /> : null}
          <PeriodControl
            current={range}
            basePath="/dashboard/revenue"
            params={status === "all" ? undefined : { status }}
          />
        </div>
      </header>

      {/*
        Hierarchy: the bridge is the thesis of this page, so it gets the width,
        the headline figure and the identity strip. The MRR level sits beside it
        as a companion on its own scale — never sharing an axis with movement.
      */}
      <div className="rise mt-3 grid gap-3 [animation-delay:60ms] xl:grid-cols-[1.75fr_1fr]">
        <SectionBoundary
          title="The revenue bridge didn't load"
          description="The movement query failed. Retry it — the rest of this page is unaffected."
        >
          <Suspense fallback={<BridgePanelSkeleton />}>
            <BridgePanel
              movementPromise={movementPromise}
              summaryPromise={summaryPromise}
            />
          </Suspense>
        </SectionBoundary>

        <SectionBoundary
          title="The MRR trend didn't load"
          description="The snapshot query failed. Retry it, or read the bridge beside it in the meantime."
        >
          <Suspense fallback={<TrendPanelSkeleton />}>
            <TrendPanel trendPromise={trendPromise} summaryPromise={summaryPromise} />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise [animation-delay:120ms]">
        <SectionBoundary
          title="Billing totals didn't load"
          description="Run rate, collections, and outstanding balance failed to fetch. Retry them — the bridge above is unaffected."
        >
          <Suspense fallback={<RevenueTilesSkeleton />}>
            <RevenueTiles summaryPromise={summaryPromise} totalsPromise={totalsPromise} />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise [animation-delay:180ms]">
        <SectionBoundary
          title="Invoices didn't load"
          description="Billing history failed to fetch. Retry it — no invoice was affected, only this view."
        >
          <Suspense fallback={<InvoiceLedgerSkeleton />}>
            <InvoiceLedger
              invoicesPromise={invoicesPromise}
              range={range}
              status={status}
              cursors={cursors}
            />
          </Suspense>
        </SectionBoundary>
      </div>
    </main>
  );
}
