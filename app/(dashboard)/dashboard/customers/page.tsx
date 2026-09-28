// Customers. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// A customer is one of the ACTIVE WORKSPACE's paying customers — a `Customer`
// row — not a workspace. Where each one stands (active / churned / not paying
// yet), their MRR and their dates are derived from their subscriptions in
// lib/metrics.ts (`getCustomerList`), by the same definitions every other page
// uses.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. One query, started at once and handed to both sections as a promise. Each
//      section streams into its own `<Suspense>` and error boundary, so the shell
//      paints first and a failure stays in the section that shows it.
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCustomerList } from "@/lib/metrics";
import { formatDay } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import { CustomerLedger, CustomerTiles } from "@/components/dashboard/customer-sections";
import {
  CustomerLedgerSkeleton,
  CustomerTilesSkeleton,
} from "@/components/dashboard/customer-skeletons";

export const metadata: Metadata = {
  title: "Customers",
  description: "Every customer of your workspace: plan, status, and MRR.",
};

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

export default async function CustomersPage() {
  const session = await requireSession();
  const asOf = new Date();

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Customers belong to a workspace. Ask an owner to add you to theirs, or create one to start tracking revenue."
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

  // The header names the workspace; the list is started before it is awaited.
  const customersPromise = eager(getCustomerList(organizationId, asOf));
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {organization.name}
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
