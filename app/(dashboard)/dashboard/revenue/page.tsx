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
//      period through `parseRange`; `?action=add-subscription` only ever opens
//      the dialog, and only for an owner or admin.
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
  getMRRTrend,
  getMetricsSummary,
  getRecentInvoices,
  getRevenueMovement,
  resolvePeriod,
} from "@/lib/metrics";
import { getCustomerOptions, getPlanOptions } from "@/lib/billing-pickers";
import { getBillingPresence } from "@/lib/billing-presence";
import { formatDay } from "@/lib/format";
import { parseRange, periodFor } from "@/lib/period";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NoBillingData } from "@/components/billing/no-billing-data";
import { SubscriptionCreateDialog } from "@/components/billing/subscription-dialogs";
import { PeriodControl } from "@/components/dashboard/period-control";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import {
  BridgePanel,
  LatestInvoices,
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

/** Newest invoices shown here; the invoices page has the rest. */
const LATEST_INVOICES = 8;

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

  // `?action=add-subscription` — where the palette and the empty states land.
  const openAdd = params.action === "add-subscription";

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Revenue is scoped to a workspace. Create one to get started, or ask an owner to invite you to theirs."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/onboarding">Create workspace</Link>
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
    select: { role: true, organization: { select: { name: true, currency: true } } },
  });
  const organization = membership.organization;
  // The action re-checks this; members are simply not offered a control that
  // would refuse them.
  const canAddSubscription = membership.role !== "MEMBER";

  // What the Add subscription dialog offers: this workspace's own customers and
  // plans, archived ones excluded. Only fetched for someone who can use it.
  const [customerOptions, planOptions, presence] = await Promise.all([
    canAddSubscription ? getCustomerOptions(organizationId) : Promise.resolve([]),
    canAddSubscription ? getPlanOptions(organizationId) : Promise.resolve([]),
    getBillingPresence(organizationId),
  ]);

  const addDialog = canAddSubscription ? (
    <SubscriptionCreateDialog
      // Keyed on the param, so arriving from a link while already here remounts it open.
      key={openAdd ? "add" : "idle"}
      organizationId={organizationId}
      currency={organization.currency}
      customers={customerOptions}
      plans={planOptions}
      openOnMount={openAdd}
      tone={presence.subscriptions === 0 ? "primary" : "outline"}
    />
  ) : null;

  const header = (
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
      <div className="flex flex-wrap items-center gap-2">
        {addDialog}
        {presence.subscriptions > 0 ? <PeriodControl current={range} basePath="/dashboard/revenue" /> : null}
      </div>
    </header>
  );

  if (presence.subscriptions === 0) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {header}
        <NoBillingData
          shows="the revenue bridge, the MRR trend and collections"
          canWrite={canAddSubscription}
          hasPlans={presence.plans > 0}
          hasCustomers={presence.customers > 0}
        />
      </main>
    );
  }

  const summaryPromise = eager(getMetricsSummary(organizationId, period));
  const movementPromise = eager(getRevenueMovement(organizationId, HISTORY_MONTHS));
  const trendPromise = eager(getMRRTrend(organizationId, HISTORY_MONTHS));
  const totalsPromise = eager(getInvoiceTotals(organizationId, period));
  const invoicesPromise = eager(getRecentInvoices(organizationId, LATEST_INVOICES));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {header}

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
            <LatestInvoices invoicesPromise={invoicesPromise} currency={organization.currency} />
          </Suspense>
        </SectionBoundary>
      </div>
    </main>
  );
}
