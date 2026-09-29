"use server";

// Invoice writes: record, mark paid, void, mark uncollectible, delete — and the
// CSV export.
//
// File-level `"use server"`: every export is a public endpoint and the FormData
// is untrusted. Authorization is `billingWriter` (OWNER or ADMIN of the rendered
// organization, by composite key); the writes are lib/billing-ops.ts, which
// re-checks the invoice, customer and subscription ids against that organization
// and only allows the status moves that make sense (a paid invoice is never
// voided; only a draft or void one is deleted).
//
// No invoice write moves a MetricSnapshot: snapshots are derived from
// subscriptions only, so these record an audit entry but schedule no recompute.
import type { InvoiceStatus, Prisma } from "@prisma/client";
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { billingWriter, finishWrite, parseForm } from "@/lib/billing-caller";
import {
  INVOICE_ID_FIELDS,
  MARK_PAID_FIELDS,
  RECORD_INVOICE_FIELDS,
  invoiceIdSchema,
  markPaidSchema,
  recordInvoiceSchema,
  type BillingFormState,
} from "@/lib/billing-form";
import { deleteInvoiceOp, recordInvoiceOp, transitionInvoiceOp } from "@/lib/billing-ops";
import { buildCsv, csvFilename, type CsvExportResult } from "@/lib/csv/write";
import { formatEnumLabel, currencyFractionDigits } from "@/lib/format";
import { INVOICE_LIST, invoiceWhere, invoiceOrderBy, parseInvoiceFilters } from "@/lib/invoice-list";
import { parseDirection, parseListQuery, parseSort } from "@/lib/list-state";
import { prisma } from "@/lib/prisma";

export async function recordInvoice(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(recordInvoiceSchema(caller.currency), formData, RECORD_INVOICE_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await recordInvoiceOp(caller.organizationId, caller.currency, parsed.data));
}

export async function markInvoicePaid(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(markPaidSchema(), formData, MARK_PAID_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    caller,
    await transitionInvoiceOp(caller.organizationId, caller.currency, parsed.data.invoiceId, "paid", parsed.data.paidDate),
  );
}

async function transition(formData: FormData, kind: "void" | "uncollectible"): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(invoiceIdSchema(), formData, INVOICE_ID_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    caller,
    await transitionInvoiceOp(caller.organizationId, caller.currency, parsed.data.invoiceId, kind),
  );
}

export async function voidInvoice(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return transition(formData, "void");
}

export async function markInvoiceUncollectible(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return transition(formData, "uncollectible");
}

export async function deleteInvoice(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;
  const parsed = parseForm(invoiceIdSchema(), formData, INVOICE_ID_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(caller, await deleteInvoiceOp(caller.organizationId, caller.currency, parsed.data.invoiceId));
}

function day(value: Date | null): string {
  return value === null ? "" : value.toISOString().slice(0, 10);
}

/**
 * Every invoice the table's current view matches — search, status, date range
 * and order, all pages — as CSV. OWNER and ADMIN only, and audited.
 */
export async function exportInvoicesCSV(
  organizationId: string,
  raw: {
    readonly query: string;
    readonly sort: string;
    readonly dir: string;
    readonly status: string;
    readonly range: string;
  },
): Promise<CsvExportResult> {
  const check = await billingWriter(organizationId);
  if (!check.ok) return { status: "error", message: check.state.message ?? "Refused." };
  const { caller } = check;

  // The same narrowing the page applies to its URL — nothing reaches the query raw.
  const query = parseListQuery(raw.query);
  const filters = parseInvoiceFilters({ status: raw.status, range: raw.range });
  const where: Prisma.InvoiceWhereInput = invoiceWhere(caller.organizationId, query, filters);
  const rows = await prisma.invoice.findMany({
    where,
    orderBy: invoiceOrderBy(parseSort(INVOICE_LIST, raw.sort), parseDirection(raw.dir, INVOICE_LIST.defaultDir)),
    select: {
      id: true,
      amountCents: true,
      status: true,
      issuedAt: true,
      dueAt: true,
      paidAt: true,
      source: true,
      customer: { select: { name: true, email: true } },
      subscription: { select: { plan: { select: { name: true } } } },
    },
  });

  const digits = currencyFractionDigits(caller.currency);
  const label = (status: InvoiceStatus): string => formatEnumLabel(status);
  const csv = buildCsv(
    ["Number", "Customer", "Customer email", "Subscription", `Amount (${caller.currency})`, "Status", "Issued", "Due", "Paid", "Source"],
    rows.map((row) => [
      row.id.slice(-8),
      row.customer.name,
      row.customer.email ?? "",
      row.subscription === null ? "One-off" : (row.subscription.plan?.name ?? "Custom"),
      (row.amountCents / 10 ** digits).toFixed(digits),
      label(row.status),
      day(row.issuedAt),
      day(row.dueAt),
      day(row.paidAt),
      row.source,
    ]),
  );

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "invoice.exported",
      targetType: "workspace",
      targetId: caller.organizationId,
      metadata: {
        count: rows.length,
        detail: `${rows.length} invoice${rows.length === 1 ? "" : "s"} to CSV${query ? `, matching “${query}”` : ""}`,
      },
    }),
  );

  return { status: "success", csv, filename: csvFilename("invoices", caller.slug), count: rows.length };
}
