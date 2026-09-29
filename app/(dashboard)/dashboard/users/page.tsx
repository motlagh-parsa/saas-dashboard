// Users. Render mode: dynamic — it reads the session cookie and query params, so
// it is never statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. Every untrusted query param is narrowed before it reaches a query
//      (lib/user-list.ts): the search text is trimmed and capped, sort and
//      direction come from whitelists, page and page size are bounded integers.
//   4. One batch of queries, awaited together, with no `<Suspense>` — the
//      settings page's reasoning: nothing can start before the org id is known,
//      and a single table streaming in pieces would buy no latency. The page of
//      rows and the matching count share one WHERE clause (lib/user-query.ts),
//      which the CSV export uses too.
//
// The table itself — selection, bulk actions, column visibility, export, pager —
// is the `UsersTable` client island. This page decides what each row OFFERS from
// lib/user-permissions.ts; every Server Action in lib/user-actions.ts re-checks it.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatCount, formatDay, formatPersonName } from "@/lib/format";
import {
  parsePage,
  parsePerPage,
  parseSortDirection,
  parseUserQuery,
  parseUserSort,
  totalPages,
  usersHref,
  type UserListState,
} from "@/lib/user-list";
import { assignableRoles, canManage, hasAccountReach } from "@/lib/user-permissions";
import { userListOrderBy, userListWhere } from "@/lib/user-query";
import { Button } from "@/components/ui/button";
import { CreateUserDialog } from "@/components/dashboard/create-user-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { UsersTable, type UserTableRow } from "@/components/dashboard/users-table";

export const metadata: Metadata = {
  title: "Users",
  description: "Everyone with access to your workspace, their roles, and their account status.",
};

interface UsersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const state: UserListState = {
    query: parseUserQuery(params.q),
    sort: parseUserSort(params.sort),
    dir: parseSortDirection(params.dir),
    page: parsePage(params.page),
    perPage: parsePerPage(params.per_page),
  };
  // `?action=add` — where the ⌘K palette's "Add user" lands. Only honoured for
  // owners and admins below; anyone else simply never gets the dialog.
  const openAddUser = params.action === "add";

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Users are scoped to a workspace. Create one to get started, or ask an owner to invite you to theirs."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/onboarding">Create workspace</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  const where = userListWhere(organizationId, state.query);
  const workspaceRole = { organizationId: true, role: true } as const;

  const [caller, workspaceTotal, matching, members] = await Promise.all([
    // The caller's own standing: their role here (what they may do), the
    // workspace name (the header), and every workspace they belong to (whether
    // they reach far enough to suspend or delete an account).
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: {
        memberships: {
          select: { ...workspaceRole, organization: { select: { name: true } } },
        },
      },
    }),
    prisma.membership.count({ where: { organizationId } }),
    // Same WHERE as the page below, so "Showing X–Y of Z" and the pager agree
    // with the rows.
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      orderBy: userListOrderBy(state.sort, state.dir),
      skip: (state.page - 1) * state.perPage,
      take: state.perPage,
      select: {
        role: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            suspendedAt: true,
            // Read only to decide "invite outstanding" below — neither value
            // is rendered or sent to the client.
            passwordHash: true,
            inviteToken: true,
            // Every workspace they belong to — read for the account-reach
            // check only, never rendered or sent to the client.
            memberships: { select: workspaceRole },
          },
        },
      },
    }),
  ]);

  // A page past the end — a stale link, or the last rows of the last page just
  // deleted — goes to the last page that exists rather than rendering an empty
  // table with a pager that says otherwise.
  const lastPage = totalPages(matching, state.perPage);
  if (state.page > lastPage) {
    redirect(usersHref({ ...state, page: lastPage }));
  }

  const membership = caller.memberships.find((entry) => entry.organizationId === organizationId);
  if (membership === undefined) {
    // Membership revoked between resolution and this read. Reloading resolves
    // the next workspace, or the no-workspace screen.
    throw new Error("The active workspace membership disappeared mid-request.");
  }

  const callerRole = membership.role;
  const canManageUsers = callerRole !== "MEMBER";

  // Flattened to exactly what the island renders: no hashes, no tokens, no other
  // workspaces' memberships cross into the client payload.
  const rows: UserTableRow[] = members.map((member) => {
    const isViewer = member.user.id === session.user.id;
    return {
      id: member.user.id,
      name: member.user.name,
      displayName: formatPersonName(member.user.name, member.user.email),
      email: member.user.email,
      image: member.user.image,
      role: member.role,
      joinedLabel: formatDay(member.createdAt),
      suspended: member.user.suspendedAt !== null,
      invitePending: member.user.passwordHash === null && member.user.inviteToken !== null,
      isViewer,
      // An admin looking at an owner gets nothing, not a capped list.
      assignable:
        !isViewer && canManage(callerRole, member.role) ? assignableRoles(callerRole) : [],
      canManageAccount:
        !isViewer && canManageUsers && hasAccountReach(caller.memberships, member.user.memberships),
    };
  });

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {membership.organization.name}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            {formatCount(workspaceTotal)} {workspaceTotal === 1 ? "user" : "users"}
          </p>
        </div>
        {/* The action re-checks this; members are simply not offered a control
            that would refuse them — the revenue page's pattern. */}
        {canManageUsers ? (
          <CreateUserDialog
            // Keyed on the param, so arriving from the palette while already on
            // this page remounts the dialog open.
            key={openAddUser ? "add" : "idle"}
            organizationId={organizationId}
            roles={assignableRoles(callerRole)}
            openOnMount={openAddUser}
          />
        ) : null}
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
        {/* Keyed by workspace: a switch must not carry a selection or hidden
            columns from one workspace's table into another's. */}
        <UsersTable
          key={organizationId}
          organizationId={organizationId}
          organizationName={membership.organization.name}
          rows={rows}
          matching={matching}
          workspaceTotal={workspaceTotal}
          state={state}
          canManageUsers={canManageUsers}
        />
      </section>
    </main>
  );
}
