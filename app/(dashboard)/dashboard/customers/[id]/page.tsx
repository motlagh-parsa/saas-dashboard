// One customer. Render mode: dynamic — it reads the session cookie.
//
// Everything about one of the workspace's customers: who they are, what they pay
// now and have paid in total, every subscription as a timeline of segments, their
// invoices, and the audit trail of changes made to them. Owners and admins
// manage all of it from here; members read it.
//
// Tenant safety: the customer is looked up by `{ id, organizationId }` with the
// ACTIVE workspace's id, so an id from another workspace — or a made-up one — is
// a 404 (`notFound()`), indistinguishable from an id that never existed.
//
// Figures follow lib/metrics.ts and lib/snapshot-formula.ts exactly: MRR is
// amount × quantity ÷ interval months over live segments, rounded once; active
// means a live segment billing > 0; "customer since" is the first paying start.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArchiveRestore, ArrowLeft, CalendarDays, CircleDot, Receipt, Wallet } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { auditActionLabel, auditDetails } from "@/lib/audit-view";
import { requireSession } from "@/lib/auth";
import { describeTerms, subscriptionChain } from "@/lib/billing-ops";
import {
  INVOICE_ROW_SELECT,
  getPlanOptions,
  getSubscriptionOptions,
  toInvoiceRow,
} from "@/lib/billing-pickers";
import { dateToDay, type PlanOption } from "@/lib/billing-form";
import { CUSTOMERS_PATH, CUSTOMER_STATUS_LABEL, type CustomerStatus } from "@/lib/customer-list";
import { archiveCustomer, unarchiveCustomer } from "@/lib/customer-actions";
import {
  EM_DASH,
  formatDay,
  formatEnumLabel,
  formatMoneyExact,
  formatPersonName,
  formatRelativeTime,
} from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  activeCustomerIds,
  firstActiveAt,
  isLiveAt,
  roundedMonthlyCents,
  type SnapshotSegment,
} from "@/lib/snapshot-formula";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { MetricTile } from "@/components/dashboard/metric-tile";
import { ActionButton } from "@/components/billing/action-button";
import { CustomerFormDialog, DeleteCustomerDialog } from "@/components/billing/customer-dialogs";
import { RecordInvoiceDialog } from "@/components/billing/invoice-dialogs";
import { InvoicesTable } from "@/components/billing/invoices-table";
import { SubscriptionCreateDialog } from "@/components/billing/subscription-dialogs";
import {
  SubscriptionTimeline,
  type SegmentTone,
  type TimelineChain,
  type TimelineSegment,
} from "@/components/billing/subscription-timeline";
import { EYEBROW, TAG_CLASS } from "@/components/data-table/styles";

export const metadata: Metadata = {
  title: "Customer",
  description: "One customer's subscriptions, invoices and history.",
};

/** How many invoices and log entries the page lists; older ones stay stored. */
const INVOICE_LIMIT = 100;
const ACTIVITY_LIMIT = 50;

interface CustomerPageProps {
  params: Promise<{ id: string }>;
}

const STATUS_TONE: Record<CustomerStatus, string> = {
  active: "bg-positive/12 text-positive",
  past_due: "bg-brand/12 text-brand",
  churned: "bg-negative/12 text-negative",
  none: "bg-muted text-muted-foreground",
};

export default async function CustomerPage({ params }: CustomerPageProps) {
  const session = await requireSession();
  const { id } = await params;
  const now = new Date();

  const organizationId = await getActiveOrgId(session.user.id);
  // Not a member of any workspace, or a malformed id: nothing here to show.
  if (organizationId === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();

  const [membership, customer] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { currency: true } } },
    }),
    prisma.customer.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        name: true,
        email: true,
        externalId: true,
        source: true,
        createdAt: true,
        archivedAt: true,
      },
    }),
  ]);
  if (customer === null) notFound();

  const currency = membership.organization.currency;
  const canWrite = membership.role !== "MEMBER";
  const archived = customer.archivedAt !== null;

  const [segments, invoices, invoiceCount, paid, activity] = await Promise.all([
    prisma.subscription.findMany({
      where: { organizationId, customerId: customer.id },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        customerId: true,
        planId: true,
        status: true,
        amountCents: true,
        quantity: true,
        interval: true,
        intervalCount: true,
        startedAt: true,
        endedAt: true,
        canceledAt: true,
        previousSubscriptionId: true,
        plan: { select: { name: true } },
        _count: { select: { invoices: true } },
      },
    }),
    prisma.invoice.findMany({
      where: { organizationId, customerId: customer.id },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: INVOICE_LIMIT,
      select: INVOICE_ROW_SELECT,
    }),
    prisma.invoice.count({ where: { organizationId, customerId: customer.id } }),
    prisma.invoice.aggregate({
      where: { organizationId, customerId: customer.id, status: "PAID" },
      _sum: { amountCents: true },
    }),
    // Every billing entry records the customer it concerns in its metadata —
    // including entries about subscriptions and invoices since deleted.
    prisma.auditLog.findMany({
      where: { organizationId, metadata: { path: ["customerId"], equals: customer.id } },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
      include: { actor: { select: { name: true, email: true } } },
    }),
  ]);

  // ---- figures, by the snapshot formula's definitions ----------------------
  const history: SnapshotSegment[] = segments;
  const nowMs = now.getTime();
  const live = segments.filter((segment) => isLiveAt(segment, nowMs));
  const mrrCents = roundedMonthlyCents(live);
  const isActive = activeCustomerIds(history, nowMs).has(customer.id);
  const firstActive = firstActiveAt(history).get(customer.id) ?? null;
  const status: CustomerStatus = isActive
    ? live.some((segment) => segment.status === "PAST_DUE")
      ? "past_due"
      : "active"
    : firstActive !== null && firstActive <= nowMs
      ? "churned"
      : "none";
  const churnedOn =
    status === "churned"
      ? segments.reduce<Date | null>(
          (latest, segment) =>
            segment.endedAt !== null && segment.amountCents * segment.quantity > 0 && (latest === null || segment.endedAt > latest)
              ? segment.endedAt
              : latest,
          null,
        )
      : null;
  const lifetimeCents = paid._sum.amountCents ?? 0;

  // ---- timelines ------------------------------------------------------------
  const seen = new Set<string>();
  const chains: TimelineChain[] = [];
  for (const segment of [...segments].reverse()) {
    if (seen.has(segment.id)) continue;
    const chain = subscriptionChain(segments, segment.id);
    for (const member of chain) seen.add(member.id);
    const current = chain[chain.length - 1];
    if (current === undefined) continue;
    const open = current.endedAt === null || current.endedAt.getTime() > nowMs;
    const scheduledCancel = current.canceledAt !== null && current.endedAt !== null && current.endedAt.getTime() > nowMs;

    const rows: TimelineSegment[] = chain
      .map((member, index): TimelineSegment => {
        const next = chain[index + 1];
        let endedBy: string;
        let tone: SegmentTone;
        if (member.startedAt.getTime() > nowMs) {
          endedBy = `Starts ${formatDay(member.startedAt)}`;
          tone = "upcoming";
        } else if (member.endedAt === null) {
          endedBy = "Active";
          tone = "live";
        } else if (member.canceledAt !== null) {
          const future = member.endedAt.getTime() > nowMs;
          endedBy = future ? `Cancels on ${formatDay(member.endedAt)}` : "Canceled";
          tone = future ? "scheduled" : "ended";
        } else if (next !== undefined) {
          const future = member.endedAt.getTime() > nowMs;
          endedBy = future ? `Changes on ${formatDay(member.endedAt)}` : "Plan change";
          tone = future ? "scheduled" : "ended";
        } else {
          endedBy = "Ended";
          tone = "ended";
        }
        return {
          id: member.id,
          terms: describeTerms({ ...member, planName: member.plan?.name ?? null }, currency),
          span: `${formatDay(member.startedAt)} → ${member.endedAt === null ? "now" : formatDay(member.endedAt)}`,
          endedBy,
          tone,
          status: formatEnumLabel(
            member.endedAt !== null && member.endedAt.getTime() <= nowMs ? "CANCELED" : member.status,
          ),
        };
      })
      .reverse();

    chains.push({
      current: {
        id: current.id,
        customerName: customer.name,
        planId: current.planId,
        planName: current.plan?.name ?? null,
        amountCents: current.amountCents,
        quantity: current.quantity,
        interval: current.interval,
        intervalCount: current.intervalCount,
        status: current.status,
        startedDay: dateToDay(current.startedAt),
      },
      segments: rows,
      open,
      scheduledCancel,
      invoiceCount: chain.reduce((sum, member) => sum + member._count.invoices, 0),
    });
  }
  // Running subscriptions first, then the rest by most recent start.
  chains.sort((a, b) => Number(b.open) - Number(a.open));

  // ---- write-side options ----------------------------------------------------
  // Pickers offer the active plans. A subscription already on an archived plan
  // may keep it (e.g. to add a seat), so each chain is also offered its own
  // plan — and only its own.
  const currentPlanIds = chains.flatMap((chain) => (chain.current.planId ? [chain.current.planId] : []));
  const [pickerPlans, ownPlans, subscriptionOptions] = canWrite
    ? await Promise.all([
        getPlanOptions(organizationId),
        getPlanOptions(organizationId, currentPlanIds),
        getSubscriptionOptions(organizationId, currency, customer.id),
      ])
    : [[], [], []];
  const plansFor = (chain: TimelineChain): readonly PlanOption[] => {
    const own = ownPlans.find((plan) => plan.id === chain.current.planId);
    return own === undefined || pickerPlans.some((plan) => plan.id === own.id) ? pickerPlans : [own, ...pickerPlans];
  };

  const fixedCustomer = { id: customer.id, name: customer.name };
  const invoiceRows = invoices.map((invoice) => toInvoiceRow(invoice, now));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link
        href={CUSTOMERS_PATH}
        className="rise inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        Customers
      </Link>

      {/* ---- header ---------------------------------------------------------- */}
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight">{customer.name}</h1>
            <Badge variant="secondary" className={TAG_CLASS}>
              {formatEnumLabel(customer.source)}
            </Badge>
            {archived ? (
              <Badge variant="secondary" className={TAG_CLASS}>
                Archived
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem] text-muted-foreground">
            <span>{customer.email ?? "No email"}</span>
            {customer.externalId ? <span className="font-mono">ID {customer.externalId}</span> : null}
            <span>
              {firstActive !== null ? `Customer since ${formatDay(new Date(firstActive))}` : `Added ${formatDay(customer.createdAt)}`}
            </span>
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <CustomerFormDialog organizationId={organizationId} customer={customer} />
            {archived ? (
              <ActionButton
                action={unarchiveCustomer}
                hidden={{ organizationId, customerId: customer.id }}
                label="Unarchive"
                icon={<ArchiveRestore aria-hidden />}
                successTitle="Customer unarchived"
                failureTitle="Couldn't unarchive"
              />
            ) : (
              <ActionButton
                action={archiveCustomer}
                hidden={{ organizationId, customerId: customer.id }}
                label="Archive"
                icon={<Archive aria-hidden />}
                successTitle="Customer archived"
                failureTitle="Couldn't archive"
              />
            )}
            <DeleteCustomerDialog
              organizationId={organizationId}
              customer={customer}
              subscriptions={segments.length}
              invoices={invoiceCount}
            />
          </div>
        ) : null}
      </header>

      {archived ? (
        <p className="rise rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Archived {formatDay(customer.archivedAt ?? now)}: hidden from pickers and the default customer list. Their
          history still counts in every metric. Unarchive to add subscriptions or invoices.
        </p>
      ) : null}

      {/* ---- KPI tiles ------------------------------------------------------- */}
      <section aria-label="Customer figures" className="rise mt-2 grid gap-3 [animation-delay:60ms] sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Current MRR" icon={Wallet} delta={null} footnote="Live subscriptions, per month">
          <span data-testid="customer-mrr">{formatMoneyExact(mrrCents, currency)}</span>
        </MetricTile>
        <MetricTile label="Lifetime revenue" icon={Receipt} delta={null} footnote="Sum of paid invoices">
          {formatMoneyExact(lifetimeCents, currency)}
        </MetricTile>
        <MetricTile label="Status" icon={CircleDot} delta={null} footnote="By subscription dates, not invoices">
          <Badge variant="secondary" className={`text-sm font-medium ${STATUS_TONE[status]}`} data-testid="customer-status">
            {CUSTOMER_STATUS_LABEL[status]}
          </Badge>
        </MetricTile>
        <MetricTile
          label={status === "churned" ? "Churned on" : "Active since"}
          icon={CalendarDays}
          delta={null}
          footnote={status === "churned" ? "When the last paying subscription ended" : "First day they paid"}
        >
          {status === "churned" && churnedOn !== null
            ? formatDay(churnedOn)
            : firstActive !== null
              ? formatDay(new Date(firstActive))
              : EM_DASH}
        </MetricTile>
      </section>

      {/* ---- subscriptions --------------------------------------------------- */}
      <section aria-labelledby="subscriptions-heading" className="rise mt-3 flex flex-col gap-3 [animation-delay:120ms]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="subscriptions-heading" className={EYEBROW}>
            Subscriptions
          </h2>
          {canWrite && !archived ? (
            <SubscriptionCreateDialog
              organizationId={organizationId}
              currency={currency}
              customers={[fixedCustomer]}
              plans={pickerPlans}
              fixedCustomer={fixedCustomer}
            />
          ) : null}
        </div>
        {chains.length === 0 ? (
          <Card className="px-4 py-8 text-center text-sm text-muted-foreground">
            No subscriptions yet.
            {canWrite && !archived
              ? " Add one — a past start date is fine; it counts toward MRR from that day."
              : ""}
          </Card>
        ) : (
          <SubscriptionTimeline
            organizationId={organizationId}
            currency={currency}
            chains={chains}
            plansFor={plansFor}
            canWrite={canWrite}
          />
        )}
      </section>

      {/* ---- invoices -------------------------------------------------------- */}
      <section aria-labelledby="invoices-heading" className="rise mt-3 flex flex-col gap-3 [animation-delay:150ms]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="invoices-heading" className={EYEBROW}>
            Invoices{invoiceCount > INVOICE_LIMIT ? ` — latest ${INVOICE_LIMIT} of ${invoiceCount}` : ""}
          </h2>
          {canWrite && !archived ? (
            <RecordInvoiceDialog
              organizationId={organizationId}
              currency={currency}
              customers={[fixedCustomer]}
              subscriptions={subscriptionOptions}
              fixedCustomer={fixedCustomer}
            />
          ) : null}
        </div>
        <Card className="gap-0 py-0">
          <InvoicesTable
            organizationId={organizationId}
            currency={currency}
            rows={invoiceRows}
            canWrite={canWrite}
            mode={{ kind: "embedded" }}
          />
        </Card>
      </section>

      {/* ---- activity -------------------------------------------------------- */}
      <section aria-labelledby="activity-heading" className="rise mt-3 [animation-delay:180ms]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <h2 id="activity-heading" className={EYEBROW}>
              Activity
            </h2>
          </CardHeader>
          {activity.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No changes recorded yet. Every add, change, cancellation and invoice made here is logged.
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                  <span className="font-medium text-foreground">{auditActionLabel(entry.action)}</span>
                  <span className="min-w-0 flex-1 text-muted-foreground">{auditDetails(entry.action, entry.metadata)}</span>
                  <span className="text-xs text-muted-foreground">
                    {entry.actor ? formatPersonName(entry.actor.name, entry.actor.email) : "A deleted user"}
                    {" · "}
                    <time dateTime={entry.createdAt.toISOString()} title={entry.createdAt.toISOString()}>
                      {formatRelativeTime(entry.createdAt, now)}
                    </time>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      {!canWrite ? (
        <p className="text-xs text-muted-foreground">Only owners and admins can change billing data.</p>
      ) : null}
    </main>
  );
}
