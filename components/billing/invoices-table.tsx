"use client";

// The invoices table. One component for both places invoices are managed:
//   - /dashboard/invoices — the full data table: search, status and date-range
//     filters, sortable columns, column visibility, CSV export, the pager;
//   - a customer's page — the same rows and row actions, embedded, without the
//     customer column or the toolbar.
//
// Rows arrive pre-formatted from the server (dates as labels), so both sides of
// hydration print the same text.
import Link from "next/link";
import type { InvoiceStatus } from "@prisma/client";
import { SearchX } from "lucide-react";

import { cn } from "@/lib/utils";
import { customerHref } from "@/lib/customer-list";
import { exportInvoicesCSV } from "@/lib/invoice-actions";
import {
  INVOICE_LIST,
  INVOICE_RANGES,
  INVOICE_SORTS,
  INVOICE_STATUS_FILTERS,
  invoiceExtras,
  type InvoiceFilters,
  type InvoiceSortKey,
  type InvoiceTableRow,
} from "@/lib/invoice-list";
import { EM_DASH, formatCount, formatEnumLabel, formatMoneyExact } from "@/lib/format";
import { listHref, pageSpan, sortHref, totalPages, type ListState } from "@/lib/list-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InvoiceRowActions } from "@/components/billing/invoice-dialogs";
import {
  ColumnVisibilityMenu,
  useColumnVisibility,
  type OptionalColumn,
} from "@/components/data-table/column-visibility";
import { DataTablePager } from "@/components/data-table/data-table-pager";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { ExportButton } from "@/components/data-table/export-button";
import { FilterChips } from "@/components/data-table/filter-chips";
import { plural } from "@/components/data-table/row-selection";
import { SortableHead } from "@/components/data-table/sortable-head";
import { EYEBROW, TABLE_HEAD } from "@/components/data-table/styles";


/** Same colours as the overview's invoice ledger: only money that will never arrive is rose. */
const STATUS_CLASS: Record<InvoiceStatus, string> = {
  PAID: "bg-positive/12 text-positive",
  OPEN: "bg-brand/12 text-brand",
  DRAFT: "bg-muted text-muted-foreground",
  VOID: "bg-muted text-muted-foreground",
  UNCOLLECTIBLE: "bg-negative/12 text-negative",
};

type OptionalInvoiceColumn = "subscription" | "due" | "paid";

const OPTIONAL_COLUMNS: readonly OptionalColumn<OptionalInvoiceColumn>[] = [
  { key: "subscription", label: "Subscription" },
  { key: "due", label: "Due" },
  { key: "paid", label: "Paid" },
];

interface PageMode {
  readonly kind: "page";
  readonly state: ListState<InvoiceSortKey>;
  readonly filters: InvoiceFilters;
  readonly matching: number;
}

interface InvoicesTableProps {
  organizationId: string;
  currency: string;
  rows: readonly InvoiceTableRow[];
  canWrite: boolean;
  /** The full data table, or embedded on a customer's page. */
  mode: PageMode | { readonly kind: "embedded" };
}

export function InvoicesTable({ organizationId, currency, rows, canWrite, mode }: InvoicesTableProps) {
  const columns = useColumnVisibility<OptionalInvoiceColumn>();
  const shows = columns.shows;
  const embedded = mode.kind === "embedded";
  const showCustomer = !embedded;

  const table =
    rows.length === 0 ? null : (
      <Table>
        <TableCaption className="sr-only">
          Invoices with their number, customer, subscription, amount, status and dates.
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className={cn(TABLE_HEAD, "pl-4")}>Number</TableHead>
            {showCustomer && mode.kind === "page" ? (
              <SortableHead
                label="Customer"
                href={sortHref(INVOICE_LIST, mode.state, INVOICE_SORTS[0], invoiceExtras(mode.filters))}
                active={mode.state.sort === "customer"}
                dir={mode.state.dir}
              />
            ) : null}
            {shows("subscription") ? (
              <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>Subscription</TableHead>
            ) : null}
            {mode.kind === "page" ? (
              <SortableHead
                label="Amount"
                href={sortHref(INVOICE_LIST, mode.state, INVOICE_SORTS[1], invoiceExtras(mode.filters))}
                active={mode.state.sort === "amount"}
                dir={mode.state.dir}
                className="text-right"
              />
            ) : (
              <TableHead className={cn(TABLE_HEAD, "text-right")}>Amount</TableHead>
            )}
            <TableHead className={TABLE_HEAD}>Status</TableHead>
            {mode.kind === "page" ? (
              <SortableHead
                label="Issued"
                href={sortHref(INVOICE_LIST, mode.state, INVOICE_SORTS[2], invoiceExtras(mode.filters))}
                active={mode.state.sort === "issued"}
                dir={mode.state.dir}
              />
            ) : (
              <TableHead className={TABLE_HEAD}>Issued</TableHead>
            )}
            {shows("due") ? (
              mode.kind === "page" ? (
                <SortableHead
                  label="Due"
                  href={sortHref(INVOICE_LIST, mode.state, INVOICE_SORTS[3], invoiceExtras(mode.filters))}
                  active={mode.state.sort === "due"}
                  dir={mode.state.dir}
                  className="hidden sm:table-cell"
                />
              ) : (
                <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>Due</TableHead>
              )
            ) : null}
            {shows("paid") ? <TableHead className={cn(TABLE_HEAD, "hidden lg:table-cell")}>Paid</TableHead> : null}
            {canWrite ? (
              <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const number = `#${row.id.slice(-8)}`;
            return (
              <TableRow key={row.id} className="border-border">
                <TableCell className="py-2.5 pl-4 font-mono text-xs text-muted-foreground">{number}</TableCell>
                {showCustomer ? (
                  <TableCell className="py-2.5">
                    <Link
                      href={customerHref(row.customerId)}
                      className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {row.customerName}
                    </Link>
                  </TableCell>
                ) : null}
                {shows("subscription") ? (
                  <TableCell className="hidden py-2.5 text-muted-foreground md:table-cell">
                    {row.planName ?? "One-off"}
                  </TableCell>
                ) : null}
                <TableCell className="py-2.5 text-right font-mono text-foreground tabular-nums">
                  {formatMoneyExact(row.amountCents, currency)}
                </TableCell>
                <TableCell className="py-2.5">
                  <Badge variant="secondary" className={cn("font-medium", STATUS_CLASS[row.status])}>
                    {formatEnumLabel(row.status)}
                  </Badge>
                  {row.overdue ? <span className="ml-1.5 text-[0.6875rem] text-negative">Overdue</span> : null}
                </TableCell>
                <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">{row.issuedLabel}</TableCell>
                {shows("due") ? (
                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                    {row.dueLabel ?? EM_DASH}
                  </TableCell>
                ) : null}
                {shows("paid") ? (
                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground lg:table-cell">
                    {row.paidLabel ?? EM_DASH}
                  </TableCell>
                ) : null}
                {canWrite ? (
                  <TableCell className="py-1.5 pr-4 text-right">
                    <InvoiceRowActions
                      organizationId={organizationId}
                      invoiceId={row.id}
                      label={`${number} · ${row.customerName}`}
                      status={row.status}
                      issuedDay={row.issuedDay}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );

  if (mode.kind === "embedded") {
    return (
      table ?? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No invoices yet.{canWrite ? " Record one above, or tick “Also record past invoices” when adding a backdated subscription." : ""}
        </p>
      )
    );
  }

  const { state, filters, matching } = mode;
  const extras = invoiceExtras(filters);
  const lastPage = totalPages(matching, state.perPage);
  const { from, to } = pageSpan(state.page, state.perPage, matching);
  const filtered = state.query !== "" || filters.status !== "all" || filters.range !== "all";

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>Invoices</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            Every invoice in this workspace. Invoices are cash — collections and outstanding balance — and never
            change MRR.
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {filtered ? `${formatCount(matching)} match` : plural(matching, "invoice")}
          </span>
        </CardAction>
      </CardHeader>

      <DataTableToolbar
        search={
          <DataTableSearch
            key={organizationId}
            query={state.query}
            label="Search invoices by customer or number"
            placeholder="Search customer or #number…"
          />
        }
      >
        <ColumnVisibilityMenu fixedLabel="Number" columns={OPTIONAL_COLUMNS} visibility={columns} />
        {canWrite ? (
          <ExportButton
            noun="invoice"
            run={() =>
              exportInvoicesCSV(organizationId, {
                query: state.query,
                sort: state.sort,
                dir: state.dir,
                status: filters.status,
                range: filters.range,
              })
            }
          />
        ) : null}
      </DataTableToolbar>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <FilterChips
          label="Filter invoices by status"
          active={filters.status}
          chips={INVOICE_STATUS_FILTERS.map((option) => ({
            key: option.key,
            label: option.label,
            href: listHref(INVOICE_LIST, { ...state, page: 1 }, invoiceExtras({ ...filters, status: option.key })),
          }))}
        />
        <FilterChips
          label="Filter invoices by issue date"
          active={filters.range}
          chips={INVOICE_RANGES.map((option) => ({
            key: option.key,
            label: option.label,
            href: listHref(INVOICE_LIST, { ...state, page: 1 }, invoiceExtras({ ...filters, range: option.key })),
          }))}
        />
      </div>

      {table ?? (
        <EmptyState
          icon={SearchX}
          title={filtered ? "No invoices match" : "No invoices yet"}
          description={
            filtered
              ? "Nothing in this workspace matches the search and filters."
              : canWrite
                ? "Record one above, or tick “Also record past invoices” when adding a backdated subscription."
                : "An owner or admin records invoices here."
          }
          action={
            filtered ? (
              <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
                <Link href={INVOICE_LIST.path} scroll={false}>
                  Show all invoices
                </Link>
              </Button>
            ) : undefined
          }
          className="mx-4 my-4 border-0 bg-transparent py-10"
        />
      )}

      {matching > 0 ? (
        <DataTablePager
          page={state.page}
          lastPage={lastPage}
          from={from}
          to={to}
          matching={matching}
          noun="invoice"
          hrefFor={(page) => listHref(INVOICE_LIST, { ...state, page }, extras)}
        />
      ) : null}
    </Card>
  );
}
