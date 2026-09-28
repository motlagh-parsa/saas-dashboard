"use client";

// The customers table: search, status filter chips, sortable columns, column
// visibility, CSV export, bulk archive / unarchive, and the pager — the shared
// data table (components/data-table/) over one server page of rows.
//
// The server decides what exists (app/(dashboard)/dashboard/customers/page.tsx,
// lib/customer-query.ts); everything that changes the result set is URL state.
// Only the selection and hidden columns are client state.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DataSource } from "@prisma/client";
import { Archive, ArchiveRestore, Loader2, SearchX, TriangleAlert, UserPlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { IDLE_BILLING_FORM } from "@/lib/billing-form";
import { archiveCustomer, exportCustomersCSV, unarchiveCustomer } from "@/lib/customer-actions";
import {
  CUSTOMER_FILTERS,
  CUSTOMER_LIST,
  CUSTOMER_SORTS,
  CUSTOMER_STATUS_LABEL,
  customerExtras,
  customerHref,
  type CustomerFilter,
  type CustomerSortKey,
  type CustomerStatus,
} from "@/lib/customer-list";
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
import { runSequentially, toastBulkOutcome } from "@/components/data-table/bulk";
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
import {
  RowCheckbox,
  SelectAllCheckbox,
  SelectionBar,
  plural,
  useRowSelection,
} from "@/components/data-table/row-selection";
import { SortableHead } from "@/components/data-table/sortable-head";
import { CONTROL_HEIGHT, EYEBROW, TABLE_HEAD, TAG_CLASS } from "@/components/data-table/styles";

export interface CustomerTableRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly source: DataSource;
  readonly archived: boolean;
  readonly status: CustomerStatus;
  readonly mrrCents: number;
  readonly livePlans: string | null;
  /** Pre-formatted on the server, so both sides print the same day. */
  readonly sinceLabel: string | null;
}

type OptionalCustomerColumn = "plans" | "status" | "since" | "source";

const OPTIONAL_COLUMNS: readonly OptionalColumn<OptionalCustomerColumn>[] = [
  { key: "plans", label: "Plan(s)" },
  { key: "status", label: "Status" },
  { key: "since", label: "Customer since" },
  { key: "source", label: "Source" },
];

/**
 * Status is state, so it is the one column where the semantic colours are
 * allowed. Past due borrows the invoice ledger's OPEN treatment: money owed,
 * not yet lost.
 */
const STATUS_CLASS: Record<CustomerStatus, string> = {
  active: "bg-positive/12 text-positive",
  past_due: "bg-brand/12 text-brand",
  churned: "bg-negative/12 text-negative",
  none: "bg-muted text-muted-foreground",
};

interface CustomersTableProps {
  organizationId: string;
  currency: string;
  rows: readonly CustomerTableRow[];
  matching: number;
  counts: Readonly<Record<CustomerFilter, number>>;
  state: ListState<CustomerSortKey>;
  filter: CustomerFilter;
  canWrite: boolean;
}

export function CustomersTable({
  organizationId,
  currency,
  rows,
  matching,
  counts,
  state,
  filter,
  canWrite,
}: CustomersTableProps) {
  const router = useRouter();
  const [refreshing, startRefresh] = React.useTransition();
  const extras = customerExtras(filter);
  const href = (next: ListState<CustomerSortKey>): string => listHref(CUSTOMER_LIST, next, extras);

  const columns = useColumnVisibility<OptionalCustomerColumn>();
  const shows = columns.shows;
  const selection = useRowSelection(href(state), canWrite ? rows : []);
  const selected = selection.selected;

  const [running, setRunning] = React.useState<"archive" | "unarchive" | null>(null);
  const busy = running !== null || refreshing;
  const toArchive = selected.filter((row) => !row.archived);
  const toUnarchive = selected.filter((row) => row.archived);

  async function runBulk(kind: "archive" | "unarchive", targets: readonly CustomerTableRow[]): Promise<void> {
    if (busy || targets.length === 0) return;
    setRunning(kind);
    const action = kind === "archive" ? archiveCustomer : unarchiveCustomer;
    const outcome = await runSequentially(
      targets,
      (target) => {
        const formData = new FormData();
        formData.set("organizationId", organizationId);
        formData.set("customerId", target.id);
        return action(IDLE_BILLING_FORM, formData);
      },
      (target) => target.name,
    );
    setRunning(null);
    selection.setSelected([]);
    startRefresh(() => router.refresh());
    toastBulkOutcome(outcome, targets.length, "customer", kind === "archive" ? "archived" : "unarchived");
  }

  const lastPage = totalPages(matching, state.perPage);
  const { from, to } = pageSpan(state.page, state.perPage, matching);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>All customers</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            A plan change keeps a customer; only stopping paying counts as churn. Archived customers keep their
            history and still count in every metric.
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {state.query ? `${formatCount(matching)} match` : plural(matching, "customer")}
          </span>
        </CardAction>
      </CardHeader>

      <DataTableToolbar
        search={
          <DataTableSearch
            key={organizationId}
            query={state.query}
            label="Search customers by name, email or external ID"
            placeholder="Search name, email or ID…"
          />
        }
      >
        <FilterChips
          label="Filter customers by status"
          active={filter}
          chips={CUSTOMER_FILTERS.map((option) => ({
            key: option.key,
            label: option.label,
            count: counts[option.key],
            href: listHref(CUSTOMER_LIST, { ...state, page: 1 }, customerExtras(option.key)),
          }))}
        />
        <ColumnVisibilityMenu fixedLabel="Customer" columns={OPTIONAL_COLUMNS} visibility={columns} />
        {canWrite ? (
          <ExportButton
            noun="customer"
            run={() => exportCustomersCSV(organizationId, state.query, state.sort, state.dir, filter)}
          />
        ) : null}
      </DataTableToolbar>

      {selected.length > 0 ? (
        <SelectionBar
          summary={`${plural(selected.length, "customer")} selected`}
          busy={busy}
          onClear={() => selection.setSelected([])}
        >
          {toArchive.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void runBulk("archive", toArchive)}
              className={cn("px-3", CONTROL_HEIGHT)}
            >
              {running === "archive" ? <Loader2 aria-hidden className="animate-spin" /> : <Archive aria-hidden />}
              Archive{toUnarchive.length > 0 ? ` ${formatCount(toArchive.length)}` : ""}
            </Button>
          ) : null}
          {toUnarchive.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void runBulk("unarchive", toUnarchive)}
              className={cn("px-3", CONTROL_HEIGHT)}
            >
              {running === "unarchive" ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <ArchiveRestore aria-hidden />
              )}
              Unarchive{toArchive.length > 0 ? ` ${formatCount(toUnarchive.length)}` : ""}
            </Button>
          ) : null}
        </SelectionBar>
      ) : null}

      {rows.length === 0 ? (
        state.query || filter !== "all" ? (
          <EmptyState
            icon={SearchX}
            title={state.query ? "No customers match that search" : `No ${filter} customers`}
            description={
              state.query
                ? `No customer in this view has a name, email or external ID containing “${state.query}”.`
                : "Nobody is in this group right now."
            }
            action={
              <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
                <Link href={listHref(CUSTOMER_LIST, { ...state, query: "", page: 1 }, {})} scroll={false}>
                  Show all customers
                </Link>
              </Button>
            }
            className="mx-4 my-4 border-0 bg-transparent py-10"
          />
        ) : (
          <EmptyState
            icon={UserPlus}
            title="No customers yet"
            description={
              canWrite
                ? "Add your first customer above, then give them a subscription — they count toward MRR from its start date."
                : "An owner or admin adds customers here."
            }
            className="mx-4 my-4 border-0 bg-transparent py-10"
          />
        )
      ) : (
        <Table>
          <TableCaption className="sr-only">
            Customers with their current MRR, plans, status, first paid date and source, page {state.page} of{" "}
            {lastPage}.
          </TableCaption>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              {canWrite ? (
                <TableHead className="w-10 pl-4">
                  <SelectAllCheckbox label="Select all customers on this page" selection={selection} disabled={busy} />
                </TableHead>
              ) : null}
              {CUSTOMER_SORTS.filter((option) => option.key !== "since").map((option) => (
                <SortableHead
                  key={option.key}
                  label={option.label}
                  href={sortHref(CUSTOMER_LIST, state, option, extras)}
                  active={option.key === state.sort}
                  dir={state.dir}
                  className={cn(option.key === "name" && !canWrite && "pl-4", option.key === "mrr" && "text-right")}
                />
              ))}
              {shows("plans") ? <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>Plan(s)</TableHead> : null}
              {shows("status") ? <TableHead className={TABLE_HEAD}>Status</TableHead> : null}
              {shows("since") ? (
                <SortableHead
                  label="Customer since"
                  href={sortHref(CUSTOMER_LIST, state, CUSTOMER_SORTS[2], extras)}
                  active={state.sort === "since"}
                  dir={state.dir}
                  className="hidden md:table-cell"
                />
              ) : null}
              {shows("source") ? (
                <TableHead className={cn(TABLE_HEAD, "hidden pr-4 lg:table-cell")}>Source</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isSelected = selection.isSelected(row.id);
              return (
                <TableRow key={row.id} data-state={isSelected ? "selected" : undefined} className="border-border">
                  {canWrite ? (
                    <TableCell className="w-10 py-2.5 pl-4">
                      <RowCheckbox
                        label={`Select ${row.name}`}
                        checked={isSelected}
                        disabled={busy}
                        onChange={(checked) => selection.toggleRow(row.id, checked)}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className={cn("py-2.5", !canWrite && "pl-4")}>
                    <div className="flex min-w-0 flex-col leading-tight">
                      <Link
                        href={customerHref(row.id)}
                        className="truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {row.email ?? EM_DASH}
                      </span>
                      {row.archived ? (
                        <span className="text-[0.6875rem] text-muted-foreground">Archived</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="py-2.5 text-right font-mono tabular-nums">
                    {row.mrrCents > 0 ? (
                      <span className="text-foreground">{formatMoneyExact(row.mrrCents, currency)}</span>
                    ) : (
                      <span className="text-muted-foreground">{EM_DASH}</span>
                    )}
                  </TableCell>
                  {shows("plans") ? (
                    <TableCell className="hidden py-2.5 sm:table-cell">
                      <span className={cn("font-medium", row.livePlans ? "text-foreground" : "text-muted-foreground")}>
                        {row.livePlans ?? EM_DASH}
                      </span>
                    </TableCell>
                  ) : null}
                  {shows("status") ? (
                    <TableCell className="py-2.5">
                      <Badge variant="secondary" className={cn("font-medium", STATUS_CLASS[row.status])}>
                        {row.status === "past_due" ? <TriangleAlert aria-hidden className="size-3" /> : null}
                        {CUSTOMER_STATUS_LABEL[row.status]}
                      </Badge>
                    </TableCell>
                  ) : null}
                  {shows("since") ? (
                    <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                      {row.sinceLabel ?? EM_DASH}
                    </TableCell>
                  ) : null}
                  {shows("source") ? (
                    <TableCell className="hidden py-2.5 pr-4 lg:table-cell">
                      <Badge variant="secondary" className={TAG_CLASS}>
                        {formatEnumLabel(row.source)}
                      </Badge>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {matching > 0 ? (
        <DataTablePager
          page={state.page}
          lastPage={lastPage}
          from={from}
          to={to}
          matching={matching}
          noun="customer"
          hrefFor={(page) => href({ ...state, page })}
        />
      ) : null}
    </Card>
  );
}
