import "server-only";

// What the billing dialogs are offered, and how an invoice row is flattened for
// the invoices table — shared by the invoices page, the revenue page and the
// customer page so they cannot drift.
//
// Pickers list only live choices: archived customers and archived plans are
// hidden (their history stays), and a subscription is offered by its CURRENT
// segment — the end of its chain — since that is what an invoice bills for.
import type { InvoiceStatus } from "@prisma/client";

import { dateToDay, type CustomerOption, type PlanOption, type SubscriptionOption } from "@/lib/billing-form";
import { formatDay, formatIntervalWords, formatPrice } from "@/lib/format";
import { CUSTOM_PLAN_LABEL } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import type { InvoiceTableRow } from "@/lib/invoice-list";

export async function getCustomerOptions(organizationId: string): Promise<CustomerOption[]> {
  return prisma.customer.findMany({
    where: { organizationId, archivedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
}

/**
 * Active plans, cheapest first. With `onlyIds`: exactly those plans, archived
 * or not — the plans a customer's subscriptions are already on.
 */
export async function getPlanOptions(organizationId: string, onlyIds?: readonly string[]): Promise<PlanOption[]> {
  return prisma.plan.findMany({
    where: onlyIds === undefined ? { organizationId, archivedAt: null } : { organizationId, id: { in: [...onlyIds] } },
    orderBy: [{ amountCents: "asc" }, { name: "asc" }],
    select: { id: true, name: true, amountCents: true, interval: true, intervalCount: true },
  });
}

/** Each unarchived customer's subscriptions, by their current segment — "Pro · $199 / month since 01 Mar 2026". */
export async function getSubscriptionOptions(
  organizationId: string,
  currency: string,
  customerId?: string,
): Promise<SubscriptionOption[]> {
  const tails = await prisma.subscription.findMany({
    where: {
      organizationId,
      next: { is: null },
      customer: { is: { organizationId, archivedAt: null, ...(customerId ? { id: customerId } : {}) } },
    },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      customerId: true,
      amountCents: true,
      quantity: true,
      interval: true,
      intervalCount: true,
      startedAt: true,
      endedAt: true,
      plan: { select: { name: true } },
    },
  });
  return tails.map((tail) => {
    const seats = tail.quantity === 1 ? "" : ` × ${tail.quantity}`;
    const ended = tail.endedAt !== null && tail.endedAt.getTime() <= Date.now() ? ` (ended ${formatDay(tail.endedAt)})` : "";
    return {
      id: tail.id,
      customerId: tail.customerId,
      label: `${tail.plan?.name ?? CUSTOM_PLAN_LABEL} · ${formatPrice(tail.amountCents, currency)}${seats} / ${formatIntervalWords(tail.interval, tail.intervalCount)} since ${formatDay(tail.startedAt)}${ended}`,
    };
  });
}

/** The fields `toInvoiceRow` reads — select exactly this. */
export const INVOICE_ROW_SELECT = {
  id: true,
  amountCents: true,
  status: true,
  issuedAt: true,
  dueAt: true,
  paidAt: true,
  customer: { select: { id: true, name: true } },
  subscription: { select: { plan: { select: { name: true } } } },
} as const;

interface InvoiceRowSource {
  readonly id: string;
  readonly amountCents: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly customer: { readonly id: string; readonly name: string };
  readonly subscription: { readonly plan: { readonly name: string } | null } | null;
}

export function toInvoiceRow(row: InvoiceRowSource, now: Date = new Date()): InvoiceTableRow {
  return {
    id: row.id,
    customerId: row.customer.id,
    customerName: row.customer.name,
    planName: row.subscription === null ? null : (row.subscription.plan?.name ?? CUSTOM_PLAN_LABEL),
    amountCents: row.amountCents,
    status: row.status,
    issuedLabel: formatDay(row.issuedAt),
    issuedDay: dateToDay(row.issuedAt),
    dueLabel: row.dueAt === null ? null : formatDay(row.dueAt),
    paidLabel: row.paidAt === null ? null : formatDay(row.paidAt),
    overdue: row.status === "OPEN" && row.dueAt !== null && row.dueAt.getTime() < now.getTime(),
  };
}
