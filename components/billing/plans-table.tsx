"use client";

// The plans table: search, All / Active / Archived, sortable columns, column
// visibility and the pager — the shared data table over one server page — with
// per-row Edit, Archive / Unarchive and Delete for owners and admins.
//
// Delete is offered only for a plan no subscription has ever used; for any other
// the row says why and offers Archive, which the server would insist on anyway.
import Link from "next/link";
import type { DataSource } from "@prisma/client";
import { Archive, ArchiveRestore, SearchX } from "lucide-react";

import { cn } from "@/lib/utils";
import { EM_DASH, formatCount, formatEnumLabel, formatIntervalWords, formatMoneyExact, formatPrice } from "@/lib/format";
import { listHref, pageSpan, sortHref, totalPages, type ListState } from "@/lib/list-state";
import { archivePlan, unarchivePlan } from "@/lib/plan-actions";
import {
  PLAN_FILTERS,
  PLAN_LIST,
  PLAN_SORTS,
  planExtras,
  type PlanFilter,
  type PlanSortKey,
} from "@/lib/plan-list";
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
import { ActionButton } from "@/components/billing/action-button";
import { DeletePlanDialog, PlanFormDialog, type PlanView } from "@/components/billing/plan-dialogs";
import {
  ColumnVisibilityMenu,
  useColumnVisibility,
  type OptionalColumn,
} from "@/components/data-table/column-visibility";
import { DataTablePager } from "@/components/data-table/data-table-pager";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { FilterChips } from "@/components/data-table/filter-chips";
import { plural } from "@/components/data-table/row-selection";
import { SortableHead } from "@/components/data-table/sortable-head";
import { EYEBROW, TABLE_HEAD, TAG_CLASS } from "@/components/data-table/styles";

export interface PlanTableRow extends PlanView {
  readonly source: DataSource;
  readonly archived: boolean;
  readonly activeSubscriptions: number;
  readonly usedBy: number;
  readonly mrrCents: number;
}

type OptionalPlanColumn = "subscriptions" | "mrr" | "status";

const OPTIONAL_COLUMNS: readonly OptionalColumn<OptionalPlanColumn>[] = [
  { key: "subscriptions", label: "Active subscriptions" },
  { key: "mrr", label: "MRR" },
  { key: "status", label: "Status" },
];

interface PlansTableProps {
  organizationId: string;
  currency: string;
  rows: readonly PlanTableRow[];
  matching: number;
  state: ListState<PlanSortKey>;
  filter: PlanFilter;
  canWrite: boolean;
}

export function PlansTable({ organizationId, currency, rows, matching, state, filter, canWrite }: PlansTableProps) {
  const columns = useColumnVisibility<OptionalPlanColumn>();
  const shows = columns.shows;
  const extras = planExtras(filter);
  const lastPage = totalPages(matching, state.perPage);
  const { from, to } = pageSpan(state.page, state.perPage, matching);
  const sort = (key: PlanSortKey) => PLAN_SORTS.find((option) => option.key === key) ?? PLAN_SORTS[0];

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>Price list</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            Subscriptions copy a plan&apos;s price when they start, so repricing never rewrites history. Archived
            plans are hidden from pickers; customers already on them keep them.
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {state.query ? `${formatCount(matching)} match` : plural(matching, "plan")}
          </span>
        </CardAction>
      </CardHeader>

      <DataTableToolbar
        search={<DataTableSearch key={organizationId} query={state.query} label="Search plans by name" placeholder="Search plans…" />}
      >
        <FilterChips
          label="Filter plans by status"
          active={filter}
          chips={PLAN_FILTERS.map((option) => ({
            key: option.key,
            label: option.label,
            href: listHref(PLAN_LIST, { ...state, page: 1 }, planExtras(option.key)),
          }))}
        />
        <ColumnVisibilityMenu fixedLabel="Name" columns={OPTIONAL_COLUMNS} visibility={columns} />
      </DataTableToolbar>

      {rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No plans match"
          description="Nothing in this workspace matches the search and filter."
          action={
            <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
              <Link href={PLAN_LIST.path} scroll={false}>
                Show all plans
              </Link>
            </Button>
          }
          className="mx-4 my-4 border-0 bg-transparent py-10"
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">
            Plans with their price, live subscriptions, MRR and status, page {state.page} of {lastPage}.
          </TableCaption>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <SortableHead
                label="Name"
                href={sortHref(PLAN_LIST, state, sort("name"), extras)}
                active={state.sort === "name"}
                dir={state.dir}
                className="pl-4"
              />
              <SortableHead
                label="Price"
                href={sortHref(PLAN_LIST, state, sort("price"), extras)}
                active={state.sort === "price"}
                dir={state.dir}
              />
              {shows("subscriptions") ? (
                <SortableHead
                  label="Active subscriptions"
                  href={sortHref(PLAN_LIST, state, sort("subscriptions"), extras)}
                  active={state.sort === "subscriptions"}
                  dir={state.dir}
                  className="hidden text-right sm:table-cell"
                />
              ) : null}
              {shows("mrr") ? (
                <SortableHead
                  label="MRR"
                  href={sortHref(PLAN_LIST, state, sort("mrr"), extras)}
                  active={state.sort === "mrr"}
                  dir={state.dir}
                  className="text-right"
                />
              ) : null}
              {shows("status") ? <TableHead className={TABLE_HEAD}>Status</TableHead> : null}
              {canWrite ? (
                <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="border-border">
                <TableCell className="py-2.5 pl-4">
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate font-medium text-foreground">{row.name}</span>
                    {row.source !== "MANUAL" ? (
                      <span className="text-[0.6875rem] text-muted-foreground">{formatEnumLabel(row.source)}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="py-2.5 font-mono text-sm whitespace-nowrap tabular-nums">
                  {formatPrice(row.amountCents, currency)}
                  <span className="text-muted-foreground"> / {formatIntervalWords(row.interval, row.intervalCount)}</span>
                </TableCell>
                {shows("subscriptions") ? (
                  <TableCell className="hidden py-2.5 text-right font-mono tabular-nums sm:table-cell">
                    {formatCount(row.activeSubscriptions)}
                  </TableCell>
                ) : null}
                {shows("mrr") ? (
                  <TableCell className="py-2.5 text-right font-mono tabular-nums">
                    {row.mrrCents > 0 ? formatMoneyExact(row.mrrCents, currency) : <span className="text-muted-foreground">{EM_DASH}</span>}
                  </TableCell>
                ) : null}
                {shows("status") ? (
                  <TableCell className="py-2.5">
                    {row.archived ? (
                      <Badge variant="secondary" className={TAG_CLASS}>
                        Archived
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-positive/12 font-medium text-positive">
                        Active
                      </Badge>
                    )}
                  </TableCell>
                ) : null}
                {canWrite ? (
                  <TableCell className="py-1.5 pr-4">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <PlanFormDialog organizationId={organizationId} currency={currency} plan={row} />
                      {row.archived ? (
                        <ActionButton
                          action={unarchivePlan}
                          hidden={{ organizationId, planId: row.id }}
                          label="Unarchive"
                          ariaLabel={`Unarchive ${row.name}`}
                          icon={<ArchiveRestore aria-hidden />}
                          successTitle="Plan unarchived"
                          failureTitle="Couldn't unarchive the plan"
                        />
                      ) : (
                        <ActionButton
                          action={archivePlan}
                          hidden={{ organizationId, planId: row.id }}
                          label="Archive"
                          ariaLabel={`Archive ${row.name}`}
                          icon={<Archive aria-hidden />}
                          successTitle="Plan archived"
                          failureTitle="Couldn't archive the plan"
                        />
                      )}
                      {row.usedBy === 0 ? (
                        <DeletePlanDialog organizationId={organizationId} plan={row} />
                      ) : (
                        <span
                          className="max-w-44 text-right text-[0.6875rem] leading-tight text-muted-foreground"
                          title="A plan that subscriptions reference can't be deleted — archive it to stop offering it."
                        >
                          Used by {plural(row.usedBy, "subscription")} — archive instead of deleting
                        </span>
                      )}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
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
          noun="plan"
          hrefFor={(page) => listHref(PLAN_LIST, { ...state, page }, extras)}
        />
      ) : null}
    </Card>
  );
}
