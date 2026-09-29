"use server";

// Customer writes: add, edit, archive, unarchive, delete — and the CSV export.
//
// File-level `"use server"`: the dialogs and table that call these are client
// islands, so every export is a public endpoint and everything in the FormData
// is untrusted. Authorization is `billingWriter` (lib/billing-caller.ts): the
// caller must be an OWNER or ADMIN of the organization the form was rendered
// for, by composite key. The writes themselves are lib/billing-ops.ts, which
// re-checks every record id against that organization.
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { billingWriter, finishWrite, parseForm, readId } from "@/lib/billing-caller";
import {
  CUSTOMER_FIELDS,
  DELETE_CUSTOMER_FIELDS,
  customerSchema,
  type BillingFormState,
} from "@/lib/billing-form";
import {
  createCustomerOp,
  deleteCustomerOp,
  setCustomerArchivedOp,
  updateCustomerOp,
} from "@/lib/billing-ops";
import { buildCsv, csvFilename, type CsvExportResult } from "@/lib/csv/write";
import { CUSTOMER_LIST, CUSTOMER_STATUS_LABEL, parseCustomerFilter } from "@/lib/customer-list";
import { getCustomerExportRows } from "@/lib/customer-query";
import { currencyFractionDigits } from "@/lib/format";
import { parseDirection, parseListQuery, parseSort } from "@/lib/list-state";

export async function createCustomer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const parsed = parseForm(customerSchema(), formData, CUSTOMER_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(check.caller, await createCustomerOp(check.caller.organizationId, parsed.data));
}

export async function updateCustomer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const customerId = readId(formData, "customerId");
  if (!customerId.ok) return customerId.state;
  const parsed = parseForm(customerSchema(), formData, CUSTOMER_FIELDS);
  if (!parsed.ok) return parsed.state;
  return finishWrite(
    check.caller,
    await updateCustomerOp(check.caller.organizationId, customerId.data, parsed.data),
  );
}

async function setArchived(formData: FormData, archived: boolean): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const customerId = readId(formData, "customerId");
  if (!customerId.ok) return customerId.state;
  return finishWrite(
    check.caller,
    await setCustomerArchivedOp(check.caller.organizationId, customerId.data, archived),
  );
}

export async function archiveCustomer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return setArchived(formData, true);
}

export async function unarchiveCustomer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  return setArchived(formData, false);
}

/** Deletes the customer with their subscriptions and invoices. The typed name is re-checked. */
export async function deleteCustomer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const customerId = readId(formData, "customerId");
  if (!customerId.ok) return customerId.state;
  const confirmName = formData.get(DELETE_CUSTOMER_FIELDS[1]);
  return finishWrite(
    check.caller,
    await deleteCustomerOp(
      check.caller.organizationId,
      customerId.data,
      typeof confirmName === "string" ? confirmName : "",
    ),
  );
}

/**
 * Every customer the table's current view matches — search, status filter and
 * order, all pages — as CSV. OWNER and ADMIN only, and recorded in the audit
 * log, like the users export.
 */
export async function exportCustomersCSV(
  organizationId: string,
  rawQuery: string,
  rawSort: string,
  rawDir: string,
  rawFilter: string,
): Promise<CsvExportResult> {
  const check = await billingWriter(organizationId);
  if (!check.ok) return { status: "error", message: check.state.message ?? "Refused." };
  const { caller } = check;

  // The same narrowing the page applies to its URL — nothing reaches the query raw.
  const query = parseListQuery(rawQuery);
  const filter = parseCustomerFilter(rawFilter);
  const rows = await getCustomerExportRows(caller.organizationId, {
    query,
    sort: parseSort(CUSTOMER_LIST, rawSort),
    dir: parseDirection(rawDir, CUSTOMER_LIST.defaultDir),
    filter,
  });

  const digits = currencyFractionDigits(caller.currency);
  const csv = buildCsv(
    ["Name", "Email", "External ID", `Current MRR (${caller.currency})`, "Plans", "Status", "Customer since", "Source", "Archived"],
    rows.map((row) => [
      row.name,
      row.email ?? "",
      row.externalId ?? "",
      (row.mrrCents / 10 ** digits).toFixed(digits),
      row.livePlans ?? "",
      CUSTOMER_STATUS_LABEL[row.status],
      row.customerSince === null ? "" : row.customerSince.toISOString().slice(0, 10),
      row.source,
      row.archived ? "yes" : "no",
    ]),
  );

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "customer.exported",
      targetType: "workspace",
      targetId: caller.organizationId,
      metadata: {
        count: rows.length,
        detail: `${rows.length} customer${rows.length === 1 ? "" : "s"} to CSV${query ? `, matching “${query}”` : ""}`,
      },
    }),
  );

  return { status: "success", csv, filename: csvFilename("customers", caller.slug), count: rows.length };
}
