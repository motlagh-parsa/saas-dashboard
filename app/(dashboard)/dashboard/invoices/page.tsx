// Invoices. Render mode: dynamic — it reads the session cookie and query
// params, so it is never statically rendered.
//
// The one place invoices are managed: every invoice of the active workspace,
// searchable, filterable by status and issue date, sortable and paged, with
// "Record invoice" and the per-row actions for owners and admins. The revenue
// page shows the newest few and links here rather than duplicating the table.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate (middleware is not authz).
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts.
//   3. Every untrusted query param is narrowed before it reaches a query
//      (lib/list-state.ts, lib/invoice-list.ts).
//   4. One page of rows and the matching count share one WHERE clause
//      (`invoiceWhere`), which the CSV export uses too.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Receipt } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import {
  INVOICE_ROW_SELECT,
  getCustomerOptions,
  getSubscriptionOptions,
  toInvoiceRow,
} from "@/lib/billing-pickers";
import { CUSTOMERS_PATH } from "@/lib/customer-list";
import { formatCount } from "@/lib/format";
import { INVOICE_LIST, invoiceExtras, invoiceOrderBy, invoiceWhere, parseInvoiceFilters } from "@/lib/invoice-list";
import { listHref, parseListState, totalPages } from "@/lib/list-state";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { RecordInvoiceDialog } from "@/components/billing/invoice-dialogs";
import { InvoicesTable } from "@/components/billing/invoices-table";
import { ImportSlot } from "@/components/billing/import-slot";

export const metadata: Metadata = {
  title: "Invoices",
  description: "Every invoice in your workspace: record, collect, void, and export.",
};

interface InvoicesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InvoicesPage({ searchParams }: InvoicesPageProps) {
  const session = await requireSession();
  const params = await searchParams;
  const now = new Date();

  const state = parseListState(INVOICE_LIST, params);
  const filters = parseInvoiceFilters({ status: params.status, range: params.range });
  // `?action=record` — where the ⌘K palette's "Record invoice" lands.
  const openRecord = params.action === "record";

  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Invoices belong to a workspace. Create one to get started, or ask an owner to invite you to theirs."
          action={
            <Button asChild className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
              <Link href="/onboarding">Create workspace</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  const where = invoiceWhere(organizationId, state.query, filters, now);
  const [membership, matching, workspaceTotal, customerCount, invoices] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { name: true, currency: true } } },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.count({ where: { organizationId } }),
    prisma.customer.count({ where: { organizationId, archivedAt: null } }),
    prisma.invoice.findMany({
      where,
      orderBy: invoiceOrderBy(state.sort, state.dir),
      skip: (state.page - 1) * state.perPage,
      take: state.perPage,
      select: INVOICE_ROW_SELECT,
    }),
  ]);
  const { organization } = membership;
  const canWrite = membership.role !== "MEMBER";

  const lastPage = totalPages(matching, state.perPage);
  if (state.page > lastPage) {
    redirect(listHref(INVOICE_LIST, { ...state, page: lastPage }, invoiceExtras(filters)));
  }

  const [customers, subscriptions] = canWrite
    ? await Promise.all([
        getCustomerOptions(organizationId),
        getSubscriptionOptions(organizationId, organization.currency),
      ])
    : [[], []];

  const header = (
    <header className="rise flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Invoices</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {organization.name}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          {formatCount(workspaceTotal)} {workspaceTotal === 1 ? "invoice" : "invoices"}
        </p>
      </div>
      {canWrite && customerCount > 0 ? (
        <RecordInvoiceDialog
          key={openRecord ? "record" : "idle"}
          organizationId={organizationId}
          currency={organization.currency}
          customers={customers}
          subscriptions={subscriptions}
          openOnMount={openRecord}
          tone="primary"
        />
      ) : null}
    </header>
  );

  // Nothing to invoice yet: an invoice needs a customer, so that is the next step.
  if (workspaceTotal === 0 && customerCount === 0) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {header}
        <EmptyState
          icon={Receipt}
          title="No invoices yet"
          description={
            canWrite
              ? "Every invoice belongs to a customer, and this workspace has none yet. Add a customer first — then record their invoices here, or have them created when you add a backdated subscription."
              : "This workspace has no invoices yet. An owner or admin records them here."
          }
          action={
            canWrite ? (
              <Button asChild className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
                <Link href={`${CUSTOMERS_PATH}?action=add`}>Add customer</Link>
              </Button>
            ) : undefined
          }
          className="rise mt-3"
        />
        {canWrite ? <ImportSlot kind="invoices" /> : null}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {header}
      <section className="rise mt-3 [animation-delay:60ms]">
        <InvoicesTable
          key={organizationId}
          organizationId={organizationId}
          currency={organization.currency}
          rows={invoices.map((invoice) => toInvoiceRow(invoice, now))}
          canWrite={canWrite}
          mode={{ kind: "page", state, filters, matching }}
        />
      </section>
    </main>
  );
}
