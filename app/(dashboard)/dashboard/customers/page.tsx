// Customers. Render mode: dynamic — it reads the session cookie and query
// params, so it is never statically rendered.
//
// A customer is one of the ACTIVE WORKSPACE's paying customers — a `Customer`
// row — not a workspace. Where each one stands (active / past due / churned /
// no subscription), their MRR and their dates are derived from their
// subscriptions by the same definitions every other page uses.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. Every untrusted query param is narrowed before it reaches a query
//      (lib/list-state.ts, lib/customer-list.ts): search text trimmed and capped,
//      sort and filter from whitelists, page and page size bounded.
//   4. The tiles stream in their own `<Suspense>`; the table's page of rows is
//      awaited directly, the users page's reasoning — one dependent query, and a
//      table streaming in pieces would buy nothing.
//
// OWNER and ADMIN get the write controls (add, bulk archive, export); a MEMBER
// sees the same data read-only. Every action re-checks the role on the server.
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, UserPlus } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCustomerList } from "@/lib/metrics";
import { getCustomerPage } from "@/lib/customer-query";
import { CUSTOMER_LIST, customerExtras, parseCustomerFilter } from "@/lib/customer-list";
import { formatCount, formatDay } from "@/lib/format";
import { listHref, parseListState, totalPages } from "@/lib/list-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionBoundary } from "@/components/dashboard/section-boundary";
import { CustomerTiles } from "@/components/dashboard/customer-sections";
import { CustomerTilesSkeleton } from "@/components/dashboard/customer-skeletons";
import { CustomerFormDialog } from "@/components/billing/customer-dialogs";
import { CustomersTable, type CustomerTableRow } from "@/components/billing/customers-table";
import { ImportSlot } from "@/components/billing/import-slot";

export const metadata: Metadata = {
  title: "Customers",
  description: "Every customer of your workspace: plan, status, and MRR.",
};

interface CustomersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Starts a query immediately and marks it handled, so a rejection before the
 * suspended section awaits it is not reported as unhandled. The original promise
 * still rejects for the section, which routes the failure to its boundary.
 */
function eager<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

export default async function CustomersPage({ searchParams }: CustomersPageProps) {
  const session = await requireSession();
  const params = await searchParams;
  const asOf = new Date();

  const state = parseListState(CUSTOMER_LIST, params);
  const filter = parseCustomerFilter(params.status);
  // `?action=add` — where the ⌘K palette's "Add customer" lands.
  const openAdd = params.action === "add";

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

  const [membership, page] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { name: true, currency: true } } },
    }),
    getCustomerPage(organizationId, { ...state, filter }, asOf),
  ]);
  const { organization } = membership;
  const canWrite = membership.role !== "MEMBER";

  // A page past the end — a stale link, or the last rows just archived — goes
  // to the last page that exists.
  const lastPage = totalPages(page.matching, state.perPage);
  if (state.page > lastPage) {
    redirect(listHref(CUSTOMER_LIST, { ...state, page: lastPage }, customerExtras(filter)));
  }

  const workspaceHasCustomers = page.counts.all + page.counts.archived > 0 || state.query !== "";

  const header = (
    <header className="rise flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {organization.name}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          {formatCount(page.counts.all)} {page.counts.all === 1 ? "customer" : "customers"} as of {formatDay(asOf)}
        </p>
      </div>
      {canWrite && workspaceHasCustomers ? (
        <CustomerFormDialog key={openAdd ? "add" : "idle"} organizationId={organizationId} openOnMount={openAdd} />
      ) : null}
    </header>
  );

  if (!workspaceHasCustomers) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {header}
        <EmptyState
          icon={UserPlus}
          title="No customers yet"
          description={
            canWrite
              ? "Customers are the people and companies who pay you. Add the first one by hand, then give them a subscription — past start dates are fine, so you can enter your history."
              : "This workspace has no customers yet. An owner or admin adds them here."
          }
          action={
            canWrite ? (
              <CustomerFormDialog
                key={openAdd ? "add" : "idle"}
                organizationId={organizationId}
                openOnMount={openAdd}
              />
            ) : undefined
          }
          className="rise mt-3"
        />
        <ImportSlot />
      </main>
    );
  }

  const rows: CustomerTableRow[] = page.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    source: row.source,
    archived: row.archived,
    status: row.status,
    mrrCents: row.mrrCents,
    livePlans: row.livePlans,
    sinceLabel: row.customerSince === null ? null : formatDay(row.customerSince),
  }));

  const customersPromise = eager(getCustomerList(organizationId, asOf));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {header}

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

      <section className="rise [animation-delay:120ms]">
        {/* Keyed by workspace: a switch must not carry a selection or hidden
            columns from one workspace's table into another's. */}
        <CustomersTable
          key={organizationId}
          organizationId={organizationId}
          currency={organization.currency}
          rows={rows}
          matching={page.matching}
          counts={page.counts}
          state={state}
          filter={filter}
          canWrite={canWrite}
        />
      </section>
    </main>
  );
}
