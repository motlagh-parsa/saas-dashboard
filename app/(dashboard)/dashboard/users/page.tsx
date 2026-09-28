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
//      (lib/user-list.ts): the search text is trimmed and capped, and sort and
//      direction come from whitelists.
//   4. One batch of queries, awaited together, with no `<Suspense>` — the
//      settings page's reasoning: nothing can start before the org id is known,
//      and a single table streaming in pieces would buy no latency.
//
// Writes. Role, suspend and delete are Server Actions in lib/user-actions.ts,
// driven per row by `UserRowActions`. What each row OFFERS is decided here from
// lib/user-permissions.ts; the actions re-check all of it.
import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma, Role } from "@prisma/client";
import { ArrowDown, ArrowUp, Building2, SearchX, Users } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  formatCount,
  formatDay,
  formatEnumLabel,
  formatInitials,
  formatPersonName,
} from "@/lib/format";
import {
  USER_SORTS,
  parseSortDirection,
  parseUserQuery,
  parseUserSort,
  userSortHref,
  type SortDirection,
  type UserSortKey,
} from "@/lib/user-list";
import { assignableRoles, canManage, hasAccountReach } from "@/lib/user-permissions";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { UserRowActions } from "@/components/dashboard/user-row-actions";
import { UsersSearch } from "@/components/dashboard/users-search";

export const metadata: Metadata = {
  title: "Users",
  description: "Everyone with access to your workspace, their roles, and their account status.",
};

const BASE_PATH = "/dashboard/users";

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

interface UsersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Sorts on the membership row, reaching into the user for the text columns.
 * Every order ends on email, which is unique, so equal keys never shuffle
 * between renders. A missing name sorts last, whatever the direction.
 */
function orderByFor(
  sort: UserSortKey,
  dir: SortDirection,
): Prisma.MembershipOrderByWithRelationInput[] {
  const tiebreak: Prisma.MembershipOrderByWithRelationInput = { user: { email: "asc" } };
  switch (sort) {
    case "name":
      return [{ user: { name: { sort: dir, nulls: "last" } } }, tiebreak];
    case "email":
      return [{ user: { email: dir } }];
    case "role":
      // Enum order is OWNER, ADMIN, MEMBER, so ascending reads most privileged first.
      return [{ role: dir }, tiebreak];
    case "joined":
      return [{ createdAt: dir }, tiebreak];
  }
}

function ariaSort(
  column: UserSortKey,
  sort: UserSortKey,
  dir: SortDirection,
): "ascending" | "descending" | undefined {
  if (column !== sort) return undefined;
  return dir === "asc" ? "ascending" : "descending";
}

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const query = parseUserQuery(params.q);
  const sort = parseUserSort(params.sort);
  const dir = parseSortDirection(params.dir);

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Users are scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking revenue."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/dashboard/settings">Open workspace settings</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  // Search narrows on the user's name OR email, case-insensitively, in Postgres.
  // With no search text the filter drops out entirely rather than matching "".
  const userFilter: Prisma.UserWhereInput | undefined = query
    ? {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      }
    : undefined;

  const workspaceRole = { organizationId: true, role: true } as const;

  const [caller, totalCount, members] = await Promise.all([
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
    prisma.membership.findMany({
      where: { organizationId, user: userFilter },
      orderBy: orderByFor(sort, dir),
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
            // Every workspace they belong to — read for the account-reach
            // check only, never rendered or sent to the client.
            memberships: { select: workspaceRole },
          },
        },
      },
    }),
  ]);

  const membership = caller.memberships.find((entry) => entry.organizationId === organizationId);
  if (membership === undefined) {
    // Membership revoked between resolution and this read. Reloading resolves
    // the next workspace, or the no-workspace screen.
    throw new Error("The active workspace membership disappeared mid-request.");
  }

  const callerRole = membership.role;
  const canManageUsers = callerRole !== "MEMBER";
  const rows = members.map((member) => {
    const isViewer = member.user.id === session.user.id;
    return {
      ...member,
      displayName: formatPersonName(member.user.name, member.user.email),
      isViewer,
      // An admin looking at an owner gets nothing, not a capped list.
      assignable:
        !isViewer && canManage(callerRole, member.role) ? assignableRoles(callerRole) : [],
      canManageAccount:
        !isViewer && canManageUsers && hasAccountReach(caller.memberships, member.user.memberships),
    };
  });

  const matchLabel = query
    ? `${formatCount(rows.length)} of ${formatCount(totalCount)} match`
    : `${formatCount(totalCount)} ${totalCount === 1 ? "user" : "users"}`;

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
            {formatCount(totalCount)} {totalCount === 1 ? "user" : "users"}
          </p>
        </div>
        {/* Keyed by workspace: a switch refreshes this page in place, and the
            old workspace's search text must not survive into the new one. */}
        <UsersSearch key={organizationId} query={query} />
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
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
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {matchLabel}
              </span>
            </CardAction>
          </CardHeader>

          {rows.length === 0 ? (
            query ? (
              <EmptyState
                icon={SearchX}
                title="No users match that search"
                description={`Nobody in ${membership.organization.name} has a name or email containing “${query}”.`}
                action={
                  <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
                    <Link href={BASE_PATH} scroll={false}>
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
                People with access to {membership.organization.name}, with their role, when they
                joined, and whether their account is active.
              </TableCaption>

              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  {USER_SORTS.map((option) => {
                    const active = option.key === sort;
                    const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
                    return (
                      <TableHead
                        key={option.key}
                        aria-sort={ariaSort(option.key, sort, dir)}
                        className={cn(
                          TABLE_HEAD,
                          option.key === "name" && "pl-4",
                          option.key === "email" && "hidden md:table-cell",
                          option.key === "joined" && "hidden sm:table-cell",
                        )}
                      >
                        <Link
                          href={userSortHref(BASE_PATH, query, { sort, dir }, option)}
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
                  })}
                  <TableHead className={TABLE_HEAD}>Status</TableHead>
                  {canManageUsers ? (
                    <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>

              <TableBody>
                {rows.map((row) => {
                  const suspended = row.user.suspendedAt !== null;

                  return (
                    <TableRow key={row.user.id} className="border-border">
                      <TableCell className="py-2.5 pl-4">
                        <div className="flex items-center gap-2.5">
                          <Avatar size="sm">
                            {/* alt="" — the name is rendered right beside it. */}
                            {row.user.image ? <AvatarImage src={row.user.image} alt="" /> : null}
                            <AvatarFallback className="font-mono text-[0.6875rem] font-medium">
                              {formatInitials(row.displayName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex min-w-0 flex-col leading-tight">
                            <span className="truncate font-medium text-foreground">
                              {row.displayName}
                            </span>
                            {/* Below `md` the email column is gone, so it rides
                                under the name instead of being dropped. */}
                            <span className="truncate font-mono text-[0.6875rem] text-muted-foreground md:hidden">
                              {row.user.email}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                        {row.user.email}
                      </TableCell>

                      <TableCell className="py-2.5">
                        <Badge variant="secondary" className={cn(ROLE_BADGE, ROLE_CLASS[row.role])}>
                          {formatEnumLabel(row.role)}
                        </Badge>
                      </TableCell>

                      <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                        {formatDay(row.createdAt)}
                      </TableCell>

                      <TableCell className="py-2.5">
                        {suspended ? (
                          <Badge variant="secondary" className="bg-negative/12 font-medium text-negative">
                            Suspended
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-positive/12 font-medium text-positive">
                            Active
                          </Badge>
                        )}
                      </TableCell>

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
                              userId={row.user.id}
                              displayName={row.displayName}
                              role={row.role}
                              suspended={suspended}
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
        </Card>
      </section>
    </main>
  );
}
