// Customers. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// What a "customer" is here: ONE WORKSPACE the caller belongs to. There is no
// Customer table, and the seed gives every organization exactly one subscription
// lifecycle of its own, so each org you can see reads as one customer with a plan
// history. This is the one page that looks ACROSS workspaces rather than at the
// resolved one — scoped by the caller's memberships, never by an id from the
// client, so it can only ever list orgs the caller could already switch into.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. One query, started at once and handed to both sections as a promise. Each
//      section streams into its own `<Suspense>` and error boundary, so the shell
//      paints first and a failure stays in the section that shows it.
//   3. Customer state is decided by DATES, not `status` — the same rule as
//      lib/metrics.ts. The seed stamps `CANCELED` on every ended segment,
//      upgrades included; only `canceledAt` marks a real cancellation.
import { Suspense } from "react";
import type { Metadata } from "next";
import type { BillingInterval, PlanTier, SubscriptionStatus } from "@prisma/client";

import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatDay } from "@/lib/format";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import {
  CustomerLedger,
  CustomerTiles,
  type CustomerRow,
  type CustomerState,
  type CustomersView,
} from "@/components/dashboard/customer-sections";
import {
  CustomerLedgerSkeleton,
  CustomerTilesSkeleton,
} from "@/components/dashboard/customer-skeletons";

export const metadata: Metadata = {
  title: "Customers",
  description: "Plan, status, and MRR for every workspace you belong to.",
};

/** Matches the `Subscription.currency` schema default. */
const DEFAULT_CURRENCY = "USD";

/** The subscription columns this page reads — one lifecycle segment. */
interface Segment {
  tier: PlanTier;
  status: SubscriptionStatus;
  amountCents: number;
  currency: string;
  interval: BillingInterval;
  startedAt: Date;
  endedAt: Date | null;
  canceledAt: Date | null;
}

interface OrganizationWithSegments {
  id: string;
  name: string;
  /** Oldest first. */
  subscriptions: Segment[];
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

/** Same live-as-of predicate as lib/metrics.ts: inactive ON the `endedAt` instant. */
function isLive(segment: Segment, asOf: Date): boolean {
  return segment.startedAt <= asOf && (segment.endedAt === null || segment.endedAt > asOf);
}

/**
 * MONTHLY contributes its full amount; YEARLY is spread evenly over 12 months.
 * `Math.round` agrees with the Postgres `ROUND()` in lib/metrics.ts because
 * `amountCents >= 0` is enforced by a CHECK constraint (see prisma/schema.prisma).
 */
function monthlyCents(segment: Segment): number {
  return segment.interval === "YEARLY" ? Math.round(segment.amountCents / 12) : segment.amountCents;
}

function toCustomerRow(org: OrganizationWithSegments, asOf: Date): CustomerRow {
  // A segment that has not started yet says nothing about today.
  const started = org.subscriptions.filter((segment) => segment.startedAt <= asOf);
  const live = started.filter((segment) => isLive(segment, asOf));
  const last = started.length > 0 ? started[started.length - 1] : null;
  const current = live.length > 0 ? live[live.length - 1] : last;

  let state: CustomerState = "inactive";
  if (live.length > 0) state = "active";
  else if (last !== null && last.canceledAt !== null) state = "churned";

  return {
    organizationId: org.id,
    name: org.name,
    tier: current?.tier ?? null,
    interval: current?.interval ?? null,
    state,
    liveStatus: live.length > 0 ? live[live.length - 1].status : null,
    mrrCents: live.reduce((sum, segment) => sum + monthlyCents(segment), 0),
    currency: current?.currency ?? DEFAULT_CURRENCY,
    customerSince: started.length > 0 ? started[0].startedAt : null,
    canceledAt: state === "churned" && last !== null ? last.canceledAt : null,
  };
}

/**
 * Every workspace the caller belongs to, with its whole segment history.
 *
 * Pulling the segments into JS is deliberate here, unlike lib/metrics.ts: an org's
 * OWN plan history is a handful of rows (three at most in the seed), and deciding
 * "live / churned / since when" per customer reads far more plainly as a walk
 * over them than as a window-function query.
 */
async function loadCustomers(userId: string, asOf: Date): Promise<CustomersView> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: {
      organization: {
        select: {
          id: true,
          name: true,
          subscriptions: {
            orderBy: { startedAt: "asc" },
            select: {
              tier: true,
              status: true,
              amountCents: true,
              currency: true,
              interval: true,
              startedAt: true,
              endedAt: true,
              canceledAt: true,
            },
          },
        },
      },
    },
  });

  const customers = memberships
    .map((membership) => toCustomerRow(membership.organization, asOf))
    .sort((a, b) => b.mrrCents - a.mrrCents || a.name.localeCompare(b.name));

  const active = customers.filter((customer) => customer.state === "active");
  const activeMrrCents = active.reduce((sum, customer) => sum + customer.mrrCents, 0);

  // Most common currency among active customers labels the average; more than one
  // means the average adds unlike amounts, and the tiles say so.
  const currencyCounts = new Map<string, number>();
  for (const customer of active) {
    currencyCounts.set(customer.currency, (currencyCounts.get(customer.currency) ?? 0) + 1);
  }
  let currency = DEFAULT_CURRENCY;
  let topCount = 0;
  for (const [code, count] of currencyCounts) {
    if (count > topCount) {
      currency = code;
      topCount = count;
    }
  }

  return {
    customers,
    activeCount: active.length,
    churnedCount: customers.filter((customer) => customer.state === "churned").length,
    averageMrrCents: active.length === 0 ? 0 : Math.round(activeMrrCents / active.length),
    currency,
    isMixedCurrency: currencyCounts.size > 1,
  };
}

export default async function CustomersPage() {
  const session = await requireSession();
  const asOf = new Date();

  const customersPromise = eager(loadCustomers(session.user.id, asOf));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            Every workspace you belong to
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            as of {formatDay(asOf)}
          </p>
        </div>
      </header>

      <div className="rise mt-3 [animation-delay:60ms]">
        <SectionBoundary
          title="Customer totals didn't load"
          description="The customer query failed. Retry it — nothing was changed, only this view."
        >
          <Suspense fallback={<CustomerTilesSkeleton />}>
            <CustomerTiles customersPromise={customersPromise} />
          </Suspense>
        </SectionBoundary>
      </div>

      <div className="rise [animation-delay:120ms]">
        <SectionBoundary
          title="Customers didn't load"
          description="The customer list failed to fetch. Retry it — nothing was changed, only this view."
        >
          <Suspense fallback={<CustomerLedgerSkeleton />}>
            <CustomerLedger customersPromise={customersPromise} />
          </Suspense>
        </SectionBoundary>
      </div>
    </main>
  );
}
