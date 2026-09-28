// The retention page. Render mode: dynamic — it reads the session cookie and a
// query param, so it is never statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. The one untrusted query param is narrowed before it reaches a query, by
//      `parseRange`.
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
  getChurnRateTrend,
  getMetricsSummary,
  getNetRevenueRetention,
  getRevenueMovement,
  resolvePeriod,
} from "@/lib/metrics";
import { getBillingPresence } from "@/lib/billing-presence";
import { formatDay } from "@/lib/format";
import { parseRange, periodFor, rangeOption } from "@/lib/period";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NoBillingData } from "@/components/billing/no-billing-data";
import { PeriodControl } from "@/components/dashboard/period-control";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import {
  ChurnTrendPanel,
  MovementSection,
  NrrTrendPanel,
  RetentionTiles,
} from "@/components/dashboard/retention-sections";
import {
  ChurnTrendPanelSkeleton,
  MovementSectionSkeleton,
  NrrTrendPanelSkeleton,
  RetentionTilesSkeleton,
} from "@/components/dashboard/retention-skeletons";

export const metadata: Metadata = {
  title: "Retention",
  description:
    "Net revenue retention, subscription churn, and the movement behind them.",
};

/** Months of history in both trends. Two charts, one window, one number. */
const HISTORY_MONTHS = 12;

interface RetentionPageProps {
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

export default async function RetentionPage({ searchParams }: RetentionPageProps) {
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
          description="Retention is scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking cohorts."
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

  // The header names the workspace the figures belong to; the role decides
  // whether an empty workspace is offered the first steps.
  const [membership, presence] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { name: true } } },
    }),
    getBillingPresence(organizationId),
  ]);
  const organization = membership.organization;

  // No subscriptions: no cohort to retain. Say what is missing.
  if (presence.subscriptions === 0) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="rise">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Retention</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">{organization.name}</p>
        </header>
        <NoBillingData
          shows="net revenue retention, churn and the movement behind them"
          canWrite={membership.role !== "MEMBER"}
          hasPlans={presence.plans > 0}
          hasCustomers={presence.customers > 0}
        />
      </main>
    );
  }

  // Four queries, started together. The `<Suspense>` boundaries below are what
  // make this parallel — awaiting any of them here would serialize the page.
  // `movementPromise` is read by TWO sections; it is fetched once.
  const summaryPromise = eager(getMetricsSummary(organizationId, period));
  const retentionPromise = eager(getNetRevenueRetention(organizationId, period));
  const movementPromise = eager(getRevenueMovement(organizationId, HISTORY_MONTHS));
  const churnTrendPromise = eager(getChurnRateTrend(organizationId, HISTORY_MONTHS));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Retention</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {organization.name}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            figures through {formatDay(asOf)}
          </p>
        </div>
        {/* The period scopes the two headline rates only. Both trends are always
            twelve months and say so on their own panels. */}
        <PeriodControl current={range} basePath="/dashboard/retention" />
      </header>

      {/*
        Hierarchy: the two rates the page exists to report come first, NRR set
        larger and carrying the brass rule. The trends underneath say where those
        rates came from, and the ledger at the bottom says what money moved.
      */}
      <div className="rise mt-3 [animation-delay:60ms]">
        <SectionBoundary
          title="Retention rates didn't load"
          description="The cohort and churn queries failed. Retry them — the trends below are unaffected."
        >
          <Suspense fallback={<RetentionTilesSkeleton />}>
            <RetentionTiles
              summaryPromise={summaryPromise}
              nrrPromise={retentionPromise}
              comparison={option.comparison}
            />
          </Suspense>
        </SectionBoundary>
      </div>

      {/*
        The two trends share a time axis, a height, and a tick density, so the
        reader can hold one against the other. They stay on separate scales: a
        rate that lives near 1.1 and one that lives near 0.03 on one axis would
        flatten both.
      */}
      <div className="rise grid gap-3 [animation-delay:120ms] xl:grid-cols-2">
        <SectionBoundary
          title="The NRR trend didn't load"
          description="The movement query failed. Retry it, or read the churn trend beside it in the meantime."
        >
          <Suspense fallback={<NrrTrendPanelSkeleton />}>
            <NrrTrendPanel movementPromise={movementPromise} />
          </Suspense>
        </SectionBoundary>

        <SectionBoundary
          title="The churn trend didn't load"
          description="The churn query failed. Retry it — the rest of this page is unaffected."
        >
          <Suspense fallback={<ChurnTrendPanelSkeleton />}>
            <ChurnTrendPanel churnTrendPromise={churnTrendPromise} />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise [animation-delay:180ms]">
        <SectionBoundary
          title="The monthly ledger didn't load"
          description="The movement query failed. Retry it — no figure above depends on this card."
        >
          <Suspense fallback={<MovementSectionSkeleton />}>
            <MovementSection
              movementPromise={movementPromise}
              summaryPromise={summaryPromise}
            />
          </Suspense>
        </SectionBoundary>
      </div>
    </main>
  );
}
