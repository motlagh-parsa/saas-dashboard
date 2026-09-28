/**
 * URL state and query shape for the invoices table: the shared
 * `?q ?sort ?dir ?page ?per_page` (lib/list-state.ts) plus `?status=` and
 * `?range=`.
 *
 * `invoiceWhere` and `invoiceOrderBy` are shared by the page and the CSV export,
 * so the file is exactly what the table shows across all its pages. Type-only
 * Prisma imports keep this module safe for the client table to import.
 */
import type { InvoiceStatus, Prisma } from "@prisma/client";

import {
  DEFAULT_PER_PAGE,
  parseChoice,
  type ListConfig,
  type ListExtras,
  type SortDirection,
  type SortOption,
} from "@/lib/list-state";

export type InvoiceSortKey = "issued" | "amount" | "due" | "customer";

export const INVOICE_SORTS: readonly SortOption<InvoiceSortKey>[] = [
  { key: "customer", label: "Customer", initialDirection: "asc" },
  { key: "amount", label: "Amount", initialDirection: "desc" },
  { key: "issued", label: "Issued", initialDirection: "desc" },
  { key: "due", label: "Due", initialDirection: "desc" },
];

export const INVOICES_PATH = "/dashboard/invoices";

export const INVOICE_LIST: ListConfig<InvoiceSortKey> = {
  path: INVOICES_PATH,
  sorts: INVOICE_SORTS,
  defaultSort: "issued",
  defaultDir: "desc",
  defaultPerPage: DEFAULT_PER_PAGE,
};

/** One invoice as the invoices table renders it — flattened and pre-formatted on the server. */
export interface InvoiceTableRow {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  /** Plan name, "Custom", or null for a one-off charge. */
  readonly planName: string | null;
  readonly amountCents: number;
  readonly status: InvoiceStatus;
  readonly issuedLabel: string;
  /** `YYYY-MM-DD` — the earliest a paid date may be. */
  readonly issuedDay: string;
  readonly dueLabel: string | null;
  readonly paidLabel: string | null;
  /** Open and past its due date. */
  readonly overdue: boolean;
}

export type InvoiceStatusFilter = "all" | "draft" | "open" | "paid" | "void" | "uncollectible";

export const INVOICE_STATUS_FILTERS: readonly {
  readonly key: InvoiceStatusFilter;
  readonly label: string;
  readonly status: InvoiceStatus | null;
}[] = [
  { key: "all", label: "All", status: null },
  { key: "open", label: "Open", status: "OPEN" },
  { key: "paid", label: "Paid", status: "PAID" },
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "uncollectible", label: "Uncollectible", status: "UNCOLLECTIBLE" },
  { key: "void", label: "Void", status: "VOID" },
];

/** Issued within the last N days, or ever. Same windows as the overview's period control, plus all time. */
export type InvoiceRange = "all" | "30d" | "3m" | "12m";

export const INVOICE_RANGES: readonly {
  readonly key: InvoiceRange;
  readonly label: string;
  readonly days: number | null;
}[] = [
  { key: "all", label: "All time", days: null },
  { key: "30d", label: "30 days", days: 30 },
  { key: "3m", label: "3 months", days: 91 },
  { key: "12m", label: "12 months", days: 365 },
];

export interface InvoiceFilters {
  readonly status: InvoiceStatusFilter;
  readonly range: InvoiceRange;
}

export function parseInvoiceFilters(raw: {
  readonly status: string | string[] | undefined;
  readonly range: string | string[] | undefined;
}): InvoiceFilters {
  return {
    status: parseChoice(
      raw.status,
      INVOICE_STATUS_FILTERS.map((filter) => filter.key),
      "all",
    ),
    range: parseChoice(
      raw.range,
      INVOICE_RANGES.map((range) => range.key),
      "all",
    ),
  };
}

export function invoiceExtras(filters: InvoiceFilters): ListExtras {
  return {
    status: filters.status === "all" ? undefined : filters.status,
    range: filters.range === "all" ? undefined : filters.range,
  };
}

const DAY_MS = 86_400_000;

/**
 * Tenant scope first, and again on the joined customer — an invoice whose
 * customer belongs to another workspace is corrupt data and must not leak.
 * Search matches the customer's name or the invoice number (the id's tail).
 */
export function invoiceWhere(
  organizationId: string,
  query: string,
  filters: InvoiceFilters,
  now: Date = new Date(),
): Prisma.InvoiceWhereInput {
  const status = INVOICE_STATUS_FILTERS.find((filter) => filter.key === filters.status)?.status ?? null;
  const days = INVOICE_RANGES.find((range) => range.key === filters.range)?.days ?? null;
  const and: Prisma.InvoiceWhereInput[] = [];
  if (status !== null) and.push({ status });
  if (days !== null) and.push({ issuedAt: { gt: new Date(now.getTime() - days * DAY_MS) } });
  if (query) {
    and.push({
      OR: [
        { customer: { is: { name: { contains: query, mode: "insensitive" } } } },
        { id: { endsWith: query.replace(/^#/, "").toLowerCase() } },
      ],
    });
  }
  return {
    organizationId,
    customer: { is: { organizationId } },
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

/** A total order for every sort, ending on id, so paging never repeats or skips a row. */
export function invoiceOrderBy(
  sort: InvoiceSortKey,
  dir: SortDirection,
): Prisma.InvoiceOrderByWithRelationInput[] {
  const tiebreak: Prisma.InvoiceOrderByWithRelationInput[] = [{ issuedAt: "desc" }, { id: "desc" }];
  switch (sort) {
    case "issued":
      return [{ issuedAt: dir }, { id: dir }];
    case "amount":
      return [{ amountCents: dir }, ...tiebreak];
    case "due":
      return [{ dueAt: { sort: dir, nulls: "last" } }, ...tiebreak];
    case "customer":
      return [{ customer: { name: dir } }, ...tiebreak];
  }
}
