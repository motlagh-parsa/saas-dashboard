// The overview. Render mode: dynamic — it reads the session cookie and a query
// param, so it is never statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. Every metric query is started at once and handed to a section as a
//      promise, so the round trips overlap and each section streams into its own
//      `<Suspense>` boundary rather than the page blocking on the slowest one.
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getActiveSubscriptions,
  getMRRTrend,
  getMetricsSummary,
  getNetRevenueRetention,
  getRecentInvoices,
  getUserActivity,
  resolvePeriod,
} from "@/lib/metrics";
import { formatDay } from "@/lib/format";
import { parseRange, periodFor, rangeOption } from "@/lib/period";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PeriodControl } from "@/components/dashboard/period-control";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import {
  HeadlinePanel,
  InvoicesPanel,
  KpiStrip,
  PlanMixPanel,
  RetentionSection,
  UserActivityStrip,
} from "@/components/dashboard/overview-sections";
import {
  HeadlinePanelSkeleton,
  InvoicesSkeleton,
  KpiStripSkeleton,
  PlanMixSkeleton,
  RetentionLedgerSkeleton,
  UserActivityStripSkeleton,
} from "@/components/dashboard/overview-skeletons";

export const metadata: Metadata = {
  title: "Overview",
  description: "MRR, retention, and billing for your workspace.",
};

interface DashboardPageProps {
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

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const range = parseRange(params.range);
  const option = rangeOption(range);
  const period = periodFor(range);
  const asOf = resolvePeriod(period).end;

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Metrics are scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking revenue."
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

  // The header names the workspace the figures belong to.
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });

  const summaryPromise = eager(getMetricsSummary(organizationId, period));
  const trendPromise = eager(getMRRTrend(organizationId, 12));
  const retentionPromise = eager(getNetRevenueRetention(organizationId, period));
  const subscriptionsPromise = eager(getActiveSubscriptions(organizationId));
  const invoicesPromise = eager(getRecentInvoices(organizationId, 8));
  const activityPromise = eager(getUserActivity(organizationId, period));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {organization.name}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            figures through {formatDay(asOf)}
          </p>
        </div>
        <PeriodControl current={range} />
      </header>

      {/*
        Hierarchy: one panel carries the number this page exists to report, and
        the retention ledger is the only thing allowed to sit beside it. Four
        equal tiles in a row would say all four numbers matter equally.
      */}
      <div className="rise mt-3 grid gap-3 [animation-delay:60ms] lg:grid-cols-[1.7fr_1fr]">
        <SectionBoundary
          title="Revenue didn't load"
          description="The MRR query failed. Retry it — the rest of this page is unaffected."
        >
          <Suspense fallback={<HeadlinePanelSkeleton />}>
            <HeadlinePanel
              summaryPromise={summaryPromise}
              trendPromise={trendPromise}
              comparison={option.comparison}
            />
          </Suspense>
        </SectionBoundary>

        <SectionBoundary
          title="Retention didn't load"
          description="The cohort query failed. Retry it, or narrow the period if this keeps timing out."
        >
          <Suspense fallback={<RetentionLedgerSkeleton />}>
            <RetentionSection
              summaryPromise={summaryPromise}
              nrrPromise={retentionPromise}
              comparison={option.comparison}
            />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise [animation-delay:120ms]">
        <SectionBoundary
          title="Headline metrics didn't load"
          description="Run rate, subscriptions, and churn failed to fetch. Retry them — the panels above are unaffected."
        >
          <Suspense fallback={<KpiStripSkeleton />}>
            <KpiStrip summaryPromise={summaryPromise} comparison={option.comparison} />
          </Suspense>
        </SectionBoundary>
      </div>

      {/*
        Its own row and its own boundary: the user figures come from a different
        source (daily snapshots) than the revenue tiles above, so a failure or a
        slow query here must not take those down with it.
      */}
      <div className="rise [animation-delay:150ms]">
        <SectionBoundary
          title="User activity didn't load"
          description="The snapshot query failed. Retry it — the revenue figures above are unaffected."
        >
          <Suspense fallback={<UserActivityStripSkeleton />}>
            <UserActivityStrip activityPromise={activityPromise} comparison={option.comparison} />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise grid gap-3 [animation-delay:180ms] xl:grid-cols-[1fr_1.6fr]">
        <SectionBoundary
          title="Plan mix didn't load"
          description="The subscription breakdown failed to fetch. Retry it, or read the totals above in the meantime."
        >
          <Suspense fallback={<PlanMixSkeleton />}>
            <PlanMixPanel subscriptionsPromise={subscriptionsPromise} />
          </Suspense>
        </SectionBoundary>

        <SectionBoundary
          title="Invoices didn't load"
          description="Billing history failed to fetch. Retry it — no invoice was affected, only this view."
        >
          <Suspense fallback={<InvoicesSkeleton />}>
            <InvoicesPanel invoicesPromise={invoicesPromise} />
          </Suspense>
        </SectionBoundary>
      </div>
    </main>
  );
}
