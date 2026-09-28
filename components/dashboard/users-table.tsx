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
// The generic parts (search, columns menu, selection, pager, export) are the
// shared data table in components/data-table/; what stays here is what only the
// Users table has — the avatar cell, role badges, and the suspend/delete bulk
// actions with their account-reach rules.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { Loader2, SearchX, Trash2, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCount, formatEnumLabel, formatInitials } from "@/lib/format";
import { pageSpan } from "@/lib/list-state";
import { deleteUser, exportUsersCSV, suspendUser, unsuspendUser } from "@/lib/user-actions";
import { IDLE_USER_ACTION, type UserActionState } from "@/lib/user-action-state";
import {
  USER_SORTS,
  totalPages,
  userSortHref,
  usersHref,
  type UserListState,
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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/dashboard/empty-state";
import { UserRowActions } from "@/components/dashboard/user-row-actions";
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
import {
  RowCheckbox,
  SelectAllCheckbox,
  SelectionBar,
  plural,
  useRowSelection,
} from "@/components/data-table/row-selection";
import { SortableHead } from "@/components/data-table/sortable-head";
import { CONTROL_HEIGHT, EYEBROW, TABLE_HEAD } from "@/components/data-table/styles";

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

type OptionalUserColumn = "email" | "role" | "joined" | "status";

const OPTIONAL_COLUMNS: readonly OptionalColumn<OptionalUserColumn>[] = [
  { key: "email", label: "Email" },
  { key: "role", label: "Role" },
  { key: "joined", label: "Joined" },
  { key: "status", label: "Status" },
];

/** Same rule as the Settings members table: only OWNER takes the brass. */
const ROLE_CLASS: Record<Role, string> = {
  OWNER: "bg-brand text-brand-foreground",
  ADMIN: "bg-muted text-muted-foreground",
  MEMBER: "bg-muted text-muted-foreground",
};

const ROLE_BADGE = "font-mono text-[0.625rem] font-medium tracking-[0.12em] uppercase";

type BulkKind = "suspend" | "unsuspend" | "delete";

type RowAction = (previous: UserActionState, formData: FormData) => Promise<UserActionState>;

const BULK: Record<BulkKind, { readonly action: RowAction; readonly verb: string }> = {
  suspend: { action: suspendUser, verb: "suspended" },
  unsuspend: { action: unsuspendUser, verb: "unsuspended" },
  delete: { action: deleteUser, verb: "deleted" },
};

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

  const columns = useColumnVisibility<OptionalUserColumn>();
  const shows = columns.shows;

  const selection = useRowSelection(
    usersHref(state),
    rows.filter((row) => row.canManageAccount),
  );
  const selected = selection.selected;

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
    const outcome = await runSequentially(
      targets,
      (target) => {
        const formData = new FormData();
        formData.set("organizationId", organizationId);
        formData.set("userId", target.id);
        return action(IDLE_USER_ACTION, formData);
      },
      (target) => target.displayName,
    );

    setRunning(null);
    setDeleteTargets(null);
    selection.setSelected([]);
    startRefresh(() => router.refresh());
    toastBulkOutcome(outcome, targets.length, "user", verb);
  }

  // ---- paging --------------------------------------------------------------------
  const lastPage = totalPages(matching, state.perPage);
  const { from, to } = pageSpan(state.page, state.perPage, matching);

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

      <DataTableToolbar
        search={
          // Keyed by workspace: a switch refreshes this page in place, and the old
          // workspace's search text must not survive into the new one.
          <DataTableSearch
            key={organizationId}
            query={state.query}
            label="Search users by name or email"
            placeholder="Search name or email…"
          />
        }
      >
        <ColumnVisibilityMenu fixedLabel="Name" columns={OPTIONAL_COLUMNS} visibility={columns} />
        {canManageUsers ? (
          <ExportButton
            noun="user"
            run={() => exportUsersCSV(organizationId, state.query, state.sort, state.dir)}
          />
        ) : null}
      </DataTableToolbar>

      {selected.length > 0 ? (
        <SelectionBar
          summary={`${plural(selected.length, "user")} selected`}
          busy={busy}
          onClear={() => selection.setSelected([])}
        >
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
        </SelectionBar>
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
                  <SelectAllCheckbox
                    label="Select all users on this page"
                    selection={selection}
                    disabled={busy}
                  />
                </TableHead>
              ) : null}

              {USER_SORTS.filter((option) => option.key === "name" || shows(option.key)).map(
                (option) => (
                  <SortableHead
                    key={option.key}
                    label={option.key === "name" ? "User" : option.label}
                    href={userSortHref(state, option)}
                    active={option.key === state.sort}
                    dir={state.dir}
                    className={cn(
                      option.key === "name" && !canManageUsers && "pl-4",
                      option.key === "email" && "hidden md:table-cell",
                      option.key === "joined" && "hidden sm:table-cell",
                    )}
                  />
                ),
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
              const isSelected = selection.isSelected(row.id);
              return (
                <TableRow
                  key={row.id}
                  data-state={isSelected ? "selected" : undefined}
                  className="border-border"
                >
                  {canManageUsers ? (
                    <TableCell className="w-10 py-2.5 pl-4">
                      <RowCheckbox
                        label={`Select ${row.displayName}`}
                        title={
                          row.canManageAccount
                            ? undefined
                            : row.isViewer
                              ? "You can't select yourself"
                              : "Also in workspaces you don't manage"
                        }
                        checked={isSelected}
                        disabled={!row.canManageAccount || busy}
                        onChange={(checked) => selection.toggleRow(row.id, checked)}
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
        <DataTablePager
          page={state.page}
          lastPage={lastPage}
          from={from}
          to={to}
          matching={matching}
          noun="user"
          hrefFor={(page) => usersHref({ ...state, page })}
        />
      ) : null}
    </Card>
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
