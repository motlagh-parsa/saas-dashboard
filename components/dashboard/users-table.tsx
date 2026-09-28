"use client";

// The users table: search, column visibility, CSV export, bulk actions, sortable
// headers, one server-side page of rows, and the pager.
//
// The SERVER decides what exists and what is allowed: it hands down exactly one
// page of rows (app/(dashboard)/dashboard/users/page.tsx), each already carrying
// what the caller may do to it (lib/user-permissions.ts). This component only
// holds what is genuinely client state:
//   - which rows are selected — scoped to the view it was made in, so a new
//     page, search or sort starts empty without an effect to clear it;
//   - which optional columns are hidden — kept across pages, reset by a reload.
//
// Everything that changes the result set (page, sort, search) is URL state,
// reached through plain links built by `usersHref`, the codebase's pattern for
// URL state: shareable, back-button-correct, and prefetched.
//
// Bulk actions reuse the per-row Server Actions one user at a time. Each is its
// own SERIALIZABLE transaction (lib/user-actions.ts); fired in parallel against
// one workspace, Postgres would abort some of them as conflicting.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Loader2,
  SearchX,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCount, formatEnumLabel, formatInitials } from "@/lib/format";
import { deleteUser, exportUsersCSV, suspendUser, unsuspendUser } from "@/lib/user-actions";
import { IDLE_USER_ACTION, type UserActionState } from "@/lib/user-action-state";
import {
  USER_SORTS,
  pageWindow,
  totalPages,
  userSortHref,
  usersHref,
  type SortDirection,
  type UserListState,
  type UserSortKey,
} from "@/lib/user-list";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { NavChip } from "@/components/dashboard/nav-chip";
import { UserRowActions } from "@/components/dashboard/user-row-actions";
import { UsersSearch } from "@/components/dashboard/users-search";
import { toast } from "@/components/dashboard/use-toast";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** One row, flattened and permission-stamped on the server. */
export interface UserTableRow {
  readonly id: string;
  readonly name: string | null;
  readonly displayName: string;
  readonly email: string;
  readonly image: string | null;
  readonly role: Role;
  /** Pre-formatted on the server, so both sides print the same day. */
  readonly joinedLabel: string;
  readonly suspended: boolean;
  readonly invitePending: boolean;
  readonly isViewer: boolean;
  readonly assignable: readonly Role[];
  /**
   * Edit, suspend, delete — and therefore bulk selection. False for the viewer
   * and for anyone who also belongs to a workspace the viewer does not manage.
   */
  readonly canManageAccount: boolean;
}

type OptionalColumn = "email" | "role" | "joined" | "status";

const OPTIONAL_COLUMNS: readonly { readonly key: OptionalColumn; readonly label: string }[] = [
  { key: "email", label: "Email" },
  { key: "role", label: "Role" },
  { key: "joined", label: "Joined" },
  { key: "status", label: "Status" },
];

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Same rule as the Settings members table: only OWNER takes the brass. */
const ROLE_CLASS: Record<Role, string> = {
  OWNER: "bg-brand text-brand-foreground",
  ADMIN: "bg-muted text-muted-foreground",
  MEMBER: "bg-muted text-muted-foreground",
};

const ROLE_BADGE = "font-mono text-[0.625rem] font-medium tracking-[0.12em] uppercase";

/** Touch first: 44px on a phone, tightened to the app's density on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-9";

const CHECKBOX_CLASS =
  "size-4 cursor-pointer rounded border-input accent-brand disabled:cursor-not-allowed disabled:opacity-40";

type BulkKind = "suspend" | "unsuspend" | "delete";

type RowAction = (previous: UserActionState, formData: FormData) => Promise<UserActionState>;

const BULK: Record<BulkKind, { readonly action: RowAction; readonly verb: string }> = {
  suspend: { action: suspendUser, verb: "suspended" },
  unsuspend: { action: unsuspendUser, verb: "unsuspended" },
  delete: { action: deleteUser, verb: "deleted" },
};

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

function ariaSort(
  column: UserSortKey,
  sort: UserSortKey,
  dir: SortDirection,
): "ascending" | "descending" | undefined {
  if (column !== sort) return undefined;
  return dir === "asc" ? "ascending" : "descending";
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface UsersTableProps {
  organizationId: string;
  organizationName: string;
  /** Exactly one page of rows, in the URL's order. */
  rows: readonly UserTableRow[];
  /** Rows matching the search across ALL pages. */
  matching: number;
  /** Everyone in the workspace, search ignored. */
  workspaceTotal: number;
  state: UserListState;
  /** OWNER or ADMIN — decides the checkbox column, bulk bar, actions and export. */
  canManageUsers: boolean;
}

export function UsersTable({
  organizationId,
  organizationName,
  rows,
  matching,
  workspaceTotal,
  state,
  canManageUsers,
}: UsersTableProps) {
  const router = useRouter();
  const [refreshing, startRefresh] = React.useTransition();

  // ---- column visibility -------------------------------------------------
  const [hidden, setHidden] = React.useState<ReadonlySet<OptionalColumn>>(new Set());
  const shows = (column: OptionalColumn): boolean => !hidden.has(column);

  function toggleColumn(column: OptionalColumn, visible: boolean): void {
    setHidden((previous) => {
      const next = new Set(previous);
      if (visible) next.delete(column);
      else next.add(column);
      return next;
    });
  }

  // ---- selection -----------------------------------------------------------
  // Tagged with the view it was made in: a different page, search, sort or page
  // size is a different view, so the old selection simply stops applying — no
  // effect needed to clear it. Pruning against `selectable` also drops rows that
  // a bulk delete (or another tab) has removed.
  const view = usersHref(state);
  const [selection, setSelection] = React.useState<{
    readonly view: string;
    readonly ids: ReadonlySet<string>;
  }>({ view, ids: new Set() });

  const selectable = rows.filter((row) => row.canManageAccount);
  const selected = selection.view === view ? selectable.filter((row) => selection.ids.has(row.id)) : [];
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const someSelected = selected.length > 0 && !allSelected;

  function setSelected(ids: Iterable<string>): void {
    setSelection({ view, ids: new Set(ids) });
  }

  function toggleRow(id: string, checked: boolean): void {
    const next = new Set(selected.map((row) => row.id));
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  // ---- bulk actions ----------------------------------------------------------
  const [running, setRunning] = React.useState<BulkKind | null>(null);
  // Captured when the confirmation opens: each delete re-renders the table and
  // shrinks the live selection, so the dialog must not read it mid-run.
  const [deleteTargets, setDeleteTargets] = React.useState<readonly UserTableRow[] | null>(null);
  const busy = running !== null || refreshing;

  const toSuspend = selected.filter((row) => !row.suspended);
  const toUnsuspend = selected.filter((row) => row.suspended);

  async function runBulk(kind: BulkKind, targets: readonly UserTableRow[]): Promise<void> {
    if (busy || targets.length === 0) return;
    setRunning(kind);

    const { action, verb } = BULK[kind];
    let done = 0;
    const failures: string[] = [];
    for (const target of targets) {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("userId", target.id);
      try {
        const result = await action(IDLE_USER_ACTION, formData);
        if (result.status === "success") done += 1;
        else failures.push(`${target.displayName}: ${result.message ?? "refused"}`);
      } catch {
        failures.push(`${target.displayName}: something went wrong`);
      }
    }

    setRunning(null);
    setDeleteTargets(null);
    setSelected([]);
    startRefresh(() => router.refresh());

    if (failures.length === 0) {
      toast.success(`${plural(done, "user")} ${verb}`);
    } else {
      toast.error(`${formatCount(failures.length)} of ${formatCount(targets.length)} couldn't be ${verb}`, {
        description: failures.slice(0, 3).join(" · "),
      });
    }
  }

  // ---- export ------------------------------------------------------------------
  const [exporting, startExport] = React.useTransition();

  function handleExport(): void {
    if (exporting) return;
    startExport(async () => {
      const result = await exportUsersCSV(organizationId, state.query, state.sort, state.dir);
      if (result.status === "error") {
        toast.error("Couldn't export users", { description: result.message });
        return;
      }
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoked on the next tick: the click has handed the URL to the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`Exported ${plural(result.count, "user")}`, { description: result.filename });
    });
  }

  // ---- paging --------------------------------------------------------------------
  const lastPage = totalPages(matching, state.perPage);
  const from = matching === 0 ? 0 : (state.page - 1) * state.perPage + 1;
  const to = Math.min(state.page * state.perPage, matching);

  const matchLabel = state.query
    ? `${formatCount(matching)} of ${formatCount(workspaceTotal)} match`
    : plural(workspaceTotal, "user");

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border pt-4">
        <div className="flex flex-col gap-1">
          <h2 className={EYEBROW}>People</h2>
          <p className="text-[0.6875rem] text-muted-foreground text-balance">
            {canManageUsers
              ? "Roles apply to this workspace. Suspending or deleting affects the whole account."
              : "Only owners and admins can change roles or accounts."}
          </p>
        </div>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{matchLabel}</span>
        </CardAction>
      </CardHeader>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {/* Keyed by workspace: a switch refreshes this page in place, and the old
            workspace's search text must not survive into the new one. */}
        <UsersSearch key={organizationId} query={state.query} />

        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className={cn("px-3", CONTROL_HEIGHT)}>
                <Columns3 aria-hidden />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {/* Name identifies the row, so it cannot be hidden. */}
              <DropdownMenuCheckboxItem checked disabled>
                Name
              </DropdownMenuCheckboxItem>
              {OPTIONAL_COLUMNS.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.key}
                  checked={shows(column.key)}
                  onCheckedChange={(checked) => toggleColumn(column.key, checked === true)}
                  // Keep the menu open, so several columns can be toggled in one go.
                  onSelect={(event) => event.preventDefault()}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {canManageUsers ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleExport}
              aria-disabled={exporting ? "true" : undefined}
              className={cn("px-3", CONTROL_HEIGHT)}
            >
              {exporting ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
              {exporting ? "Exporting…" : "Export"}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Bulk bar — only while something is selected. */}
      {selected.length > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-2"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {plural(selected.length, "user")} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {toSuspend.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void runBulk("suspend", toSuspend)}
                className={cn("px-3", CONTROL_HEIGHT)}
              >
                {running === "suspend" ? <Loader2 aria-hidden className="animate-spin" /> : null}
                Suspend{toUnsuspend.length > 0 ? ` ${formatCount(toSuspend.length)}` : ""}
              </Button>
            ) : null}
            {toUnsuspend.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void runBulk("unsuspend", toUnsuspend)}
                className={cn("px-3", CONTROL_HEIGHT)}
              >
                {running === "unsuspend" ? <Loader2 aria-hidden className="animate-spin" /> : null}
                Unsuspend{toSuspend.length > 0 ? ` ${formatCount(toUnsuspend.length)}` : ""}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => setDeleteTargets(selected)}
              className={cn("px-3", CONTROL_HEIGHT)}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              onClick={() => setSelected([])}
              aria-label="Clear selection"
              className="size-11 sm:size-9"
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      <BulkDeleteDialog
        targets={deleteTargets}
        onCancel={() => {
          if (running === null) setDeleteTargets(null);
        }}
        pending={running === "delete"}
        onConfirm={(targets) => void runBulk("delete", targets)}
      />

      {rows.length === 0 ? (
        state.query ? (
          <EmptyState
            icon={SearchX}
            title="No users match that search"
            description={`Nobody in ${organizationName} has a name or email containing “${state.query}”.`}
            action={
              <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
                <Link href={usersHref({ ...state, query: "", page: 1 })} scroll={false}>
                  Clear search
                </Link>
              </Button>
            }
            className="mx-4 my-4 border-0 bg-transparent py-10"
          />
        ) : (
          // Defensive, not expected: the caller is a member by definition.
          <EmptyState
            icon={Users}
            title="No users to show"
            description="This workspace has no memberships right now. Reload the page — your own access may have changed while this loaded."
            className="mx-4 my-4 border-0 bg-transparent py-10"
          />
        )
      ) : (
        <Table>
          <TableCaption className="sr-only">
            People with access to {organizationName}, page {state.page} of {lastPage}.
          </TableCaption>

          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              {canManageUsers ? (
                <TableHead className="w-10 pl-4">
                  <input
                    type="checkbox"
                    aria-label="Select all users on this page"
                    className={CHECKBOX_CLASS}
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelected;
                    }}
                    disabled={selectable.length === 0 || busy}
                    onChange={(event) =>
                      setSelected(event.target.checked ? selectable.map((row) => row.id) : [])
                    }
                  />
                </TableHead>
              ) : null}

              {USER_SORTS.filter((option) => option.key === "name" || shows(option.key)).map(
                (option) => {
                  const active = option.key === state.sort;
                  const Arrow = state.dir === "asc" ? ArrowUp : ArrowDown;
                  return (
                    <TableHead
                      key={option.key}
                      aria-sort={ariaSort(option.key, state.sort, state.dir)}
                      className={cn(
                        TABLE_HEAD,
                        option.key === "name" && !canManageUsers && "pl-4",
                        option.key === "email" && "hidden md:table-cell",
                        option.key === "joined" && "hidden sm:table-cell",
                      )}
                    >
                      <Link
                        href={userSortHref(state, option)}
                        scroll={false}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          active && "text-foreground",
                        )}
                      >
                        {option.key === "name" ? "User" : option.label}
                        {active ? <Arrow aria-hidden className="size-3" /> : null}
                      </Link>
                    </TableHead>
                  );
                },
              )}
              {shows("status") ? <TableHead className={TABLE_HEAD}>Status</TableHead> : null}
              {canManageUsers ? (
                <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => {
              const isSelected = selected.some((entry) => entry.id === row.id);
              return (
                <TableRow
                  key={row.id}
                  data-state={isSelected ? "selected" : undefined}
                  className="border-border"
                >
                  {canManageUsers ? (
                    <TableCell className="w-10 py-2.5 pl-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.displayName}`}
                        title={
                          row.canManageAccount
                            ? undefined
                            : row.isViewer
                              ? "You can't select yourself"
                              : "Also in workspaces you don't manage"
                        }
                        className={CHECKBOX_CLASS}
                        checked={isSelected}
                        disabled={!row.canManageAccount || busy}
                        onChange={(event) => toggleRow(row.id, event.target.checked)}
                      />
                    </TableCell>
                  ) : null}

                  <TableCell className={cn("py-2.5", !canManageUsers && "pl-4")}>
                    <div className="flex items-center gap-2.5">
                      <Avatar size="sm">
                        {/* alt="" — the name is rendered right beside it. */}
                        {row.image ? <AvatarImage src={row.image} alt="" /> : null}
                        <AvatarFallback className="font-mono text-[0.6875rem] font-medium">
                          {formatInitials(row.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate font-medium text-foreground">{row.displayName}</span>
                        {/* Below `md` the email column is gone, so it rides under the
                            name instead of being dropped — unless hidden on purpose. */}
                        {shows("email") ? (
                          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground md:hidden">
                            {row.email}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>

                  {shows("email") ? (
                    <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                      {row.email}
                    </TableCell>
                  ) : null}

                  {shows("role") ? (
                    <TableCell className="py-2.5">
                      <Badge variant="secondary" className={cn(ROLE_BADGE, ROLE_CLASS[row.role])}>
                        {formatEnumLabel(row.role)}
                      </Badge>
                    </TableCell>
                  ) : null}

                  {shows("joined") ? (
                    <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                      {row.joinedLabel}
                    </TableCell>
                  ) : null}

                  {shows("status") ? (
                    <TableCell className="py-2.5">
                      {row.suspended ? (
                        <Badge variant="secondary" className="bg-negative/12 font-medium text-negative">
                          Suspended
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="bg-positive/12 font-medium text-positive">
                          Active
                        </Badge>
                      )}
                    </TableCell>
                  ) : null}

                  {canManageUsers ? (
                    <TableCell className="py-2.5 pr-4 text-right">
                      {row.isViewer ? (
                        <Badge
                          variant="secondary"
                          className="bg-muted font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase"
                        >
                          You
                        </Badge>
                      ) : (
                        <UserRowActions
                          organizationId={organizationId}
                          userId={row.id}
                          name={row.name}
                          displayName={row.displayName}
                          role={row.role}
                          suspended={row.suspended}
                          invitePending={row.invitePending}
                          assignableRoles={row.assignable}
                          canManageAccount={row.canManageAccount}
                        />
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {matching > 0 ? (
        <Pager state={state} lastPage={lastPage} from={from} to={to} matching={matching} />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------

interface PagerProps {
  state: UserListState;
  lastPage: number;
  from: number;
  to: number;
  matching: number;
}

const PAGER_EDGE =
  "inline-flex h-11 items-center gap-1 rounded-md px-3 text-xs font-medium md:h-8";

function Pager({ state, lastPage, from, to, matching }: PagerProps) {
  const hrefFor = (page: number): string => usersHref({ ...state, page });
  const onFirst = state.page <= 1;
  const onLast = state.page >= lastPage;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="font-mono text-xs text-muted-foreground tabular-nums">
        Showing {formatCount(from)}–{formatCount(to)} of {plural(matching, "user")}
      </p>

      {lastPage > 1 ? (
        <div className="flex flex-wrap items-center gap-0.5">
          {onFirst ? (
            <span aria-disabled="true" className={cn(PAGER_EDGE, "text-muted-foreground/50")}>
              <ChevronLeft aria-hidden className="size-3.5" />
              Previous
            </span>
          ) : (
            <NavChip href={hrefFor(state.page - 1)} label="Previous page">
              <ChevronLeft aria-hidden className="size-3.5" />
              Previous
            </NavChip>
          )}

          {pageWindow(state.page, lastPage).map((entry, index) =>
            entry === "gap" ? (
              <span
                key={`gap-${index}`}
                aria-hidden
                className="inline-flex h-11 w-6 items-center justify-center text-xs text-muted-foreground md:h-8"
              >
                …
              </span>
            ) : (
              <NavChip
                key={entry}
                href={hrefFor(entry)}
                active={entry === state.page}
                label={entry === state.page ? `Page ${entry}, current page` : `Page ${entry}`}
                className="min-w-9 justify-center px-2 font-mono tabular-nums"
              >
                {entry}
              </NavChip>
            ),
          )}

          {onLast ? (
            <span aria-disabled="true" className={cn(PAGER_EDGE, "text-muted-foreground/50")}>
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </span>
          ) : (
            <NavChip href={hrefFor(state.page + 1)} label="Next page">
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </NavChip>
          )}
        </div>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Bulk delete confirmation
// ---------------------------------------------------------------------------

interface BulkDeleteDialogProps {
  /** The users to delete, fixed when the dialog opened; null means closed. */
  targets: readonly UserTableRow[] | null;
  onCancel: () => void;
  pending: boolean;
  onConfirm: (targets: readonly UserTableRow[]) => void;
}

function BulkDeleteDialog({ targets: openedWith, onCancel, pending, onConfirm }: BulkDeleteDialogProps) {
  const targets = openedWith ?? [];
  const names = targets.slice(0, 5).map((row) => row.displayName);
  const more = targets.length - names.length;

  return (
    <Dialog
      open={openedWith !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {plural(targets.length, "user")}? This cannot be undone.</DialogTitle>
          <DialogDescription>
            Each account is permanently deleted and removed from every workspace it belongs to:{" "}
            {names.join(", ")}
            {more > 0 ? `, and ${formatCount(more)} more` : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* First in DOM order, so it takes focus: Enter on the initial focus
              must not complete a delete. */}
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending} className="h-11 sm:h-8">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => onConfirm(targets)}
            className="h-11 sm:h-8"
          >
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {pending ? "Deleting…" : `Delete ${plural(targets.length, "user")}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
