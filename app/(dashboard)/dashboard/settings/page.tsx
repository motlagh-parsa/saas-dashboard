// Settings. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE from the caller's memberships.
//      No org id is ever accepted from props, params, or the client.
//   3. The member list is scoped to that resolved id.
//
// Two queries, run in sequence, with no `<Suspense>` anywhere. That is deliberate
// and it is the opposite of what the overview/revenue/retention pages do: those
// fire independent queries in parallel and stream each section separately. Here
// the second query CANNOT start until the first has returned an organization id,
// so there is nothing to overlap. Splitting a single dependent chain across
// boundaries would buy no latency and cost a layout that assembles itself in
// front of the reader for no reason.
//
// UI ONLY. Every control on this page is inert by design — no handler, no action,
// no mutation. Writes are a separate hand-off.
import type { Metadata } from "next";
import Link from "next/link";
import type { Role } from "@prisma/client";
import { Building2, Lock, UserPlus, Users } from "lucide-react";

import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  formatCount,
  formatEnumLabel,
  formatInitials,
  formatPersonName,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export const metadata: Metadata = {
  title: "Settings",
  description: "Workspace details, members, and the roles that scope this data.",
};

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

/**
 * Field labels and column headers wear the same mono caps at the same tracking.
 * A settings form and a data table are the same kind of object here — a register
 * of key/value pairs — and typing them alike is what says so.
 */
const FIELD_LABEL =
  "font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Touch first: 44px on a phone, tightened to the app's 36px on a pointer. */
const CONTROL_HEIGHT = "h-11 sm:h-9";

/**
 * Role is the only colour in this table, and only one role gets any.
 *
 * OWNER is the single privilege that changes what a person can do to the
 * workspace, so it takes the brass. ADMIN and MEMBER are deliberately identical
 * and neutral: three tinted badges in a column would encode a ramp that the
 * permission model does not actually have.
 *
 * OWNER is SOLID brass with `--brand-foreground` on it, not the `bg-brand/15
 * text-brand` wash used for tinted status elsewhere. Measured, brand-on-a-15%-
 * brand-wash is 2.7:1 in light and 3.7:1 in dark — the light value is under even
 * the 3:1 graphical floor this theme sets for its brass ramp, and this is 10px
 * text. The `--brand` / `--brand-foreground` pair is the theme's defined
 * "ink on brass" combination and measures 4.2:1 light / 6.9:1 dark instead.
 *
 * Colour is redundant here regardless: the badge says "Owner" in words, and the
 * query sorts owners to the top. Nothing is encoded in the gold alone.
 */
const ROLE_CLASS: Record<Role, string> = {
  OWNER: "bg-brand text-brand-foreground",
  ADMIN: "bg-muted text-muted-foreground",
  MEMBER: "bg-muted text-muted-foreground",
};

const ROLE_BADGE =
  "font-mono text-[0.625rem] font-medium tracking-[0.12em] uppercase";

const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

interface DangerAction {
  id: string;
  title: string;
  description: string;
  label: string;
  /** Rendered as a mono tag beside the button, saying WHY it cannot be pressed. */
  lockNote: string | null;
  disabled: boolean;
}

/**
 * The destructive actions, in ascending order of consequence.
 *
 * Leaving is reversible by someone else; deleting is reversible by nobody. The
 * second one is locked, and a disabled control with no stated reason reads as a
 * bug, so the reason ships beside it.
 */
const DANGER_ACTIONS: readonly DangerAction[] = [
  {
    id: "leave-workspace",
    title: "Leave workspace",
    description:
      "You'll lose access to this workspace's data. An owner can re-invite you.",
    label: "Leave workspace",
    lockNote: null,
    disabled: false,
  },
  {
    id: "delete-workspace",
    title: "Delete workspace",
    description:
      "Permanently deletes this workspace and all its data. This cannot be undone. Deletion stays locked while billing is active — contact support to release it.",
    label: "Delete workspace",
    lockNote: "Locked",
    disabled: true,
  },
];

export default async function SettingsPage() {
  const session = await requireSession();

  // Tenant resolution. Role enum order is OWNER, ADMIN, MEMBER, so ascending
  // role puts the caller's most privileged workspace first; oldest org breaks
  // the tie deterministically.
  const membership = await prisma.membership.findFirst({
    where: { userId: session.user.id },
    orderBy: [{ role: "asc" }, { organization: { createdAt: "asc" } }],
    select: {
      organizationId: true,
      organization: { select: { name: true, slug: true } },
    },
  });

  if (!membership) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Settings is scoped to a workspace. Ask an owner to add you to theirs, or create one to start tracking revenue."
          action={
            <Button
              asChild
              className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
            >
              <Link href="/dashboard">Back to overview</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  const organization = membership.organization;

  // Same ordering trick as above: OWNER, then ADMIN, then MEMBER, alphabetical
  // inside each. The list reads as a hierarchy without needing a group header.
  const members = await prisma.membership.findMany({
    where: { organizationId: membership.organizationId },
    orderBy: [{ role: "asc" }, { user: { name: "asc" } }],
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });

  const memberCount = members.length;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {organization.name}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          {formatCount(memberCount)} {memberCount === 1 ? "member" : "members"}
        </p>
      </header>

      {/*
        Hierarchy. There is no headline figure on a settings page, so weight comes
        from identity instead: the workspace card leads with the monogram and the
        name set at heading size, and everything below it is a register — a form,
        then a table, then the actions nobody should reach by accident.

        The three cards are NOT equal weight. Workspace is the subject, Members is
        the body, and the danger zone is set apart by its ring rather than by size.
      */}
      <section className="rise mt-3 [animation-delay:60ms]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              <h2 className={EYEBROW}>Workspace</h2>
            </div>
          </CardHeader>

          {/*
            The subject of the page, stated once, at the top. Solid brass rather
            than the tinted `bg-brand/12` used for icon chips elsewhere, because
            this one holds TEXT: brass-on-brass-wash measures 2.7:1 in light,
            while `--brand-foreground` on `--brand` is 4.2:1 / 6.9:1.

            This is the only monogram on the page that is gold. The member
            avatars below are neutral on purpose — see the table.
          */}
          <CardContent className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand font-mono text-sm font-medium text-brand-foreground"
            >
              {formatInitials(organization.name)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-heading text-base leading-snug font-medium">
                {organization.name}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every figure in this dashboard is scoped to this workspace.
              </p>
            </div>
          </CardContent>

          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workspace-name" className={FIELD_LABEL}>
                Workspace name
              </Label>
              <Input
                id="workspace-name"
                name="workspace-name"
                defaultValue={organization.name}
                aria-describedby="workspace-name-hint"
                className={CONTROL_HEIGHT}
              />
              <p id="workspace-name-hint" className="text-[0.6875rem] text-muted-foreground">
                Shown in the sidebar and on anything exported from this workspace.
              </p>
            </div>

            {/*
              The slug is READ-ONLY, so it is not an input.
              A disabled text field still looks like a thing you were supposed to
              be able to edit and are being denied; a mono chip on the muted
              surface reads as a fact about the record instead — the same way an
              invoice reference does elsewhere in the product.
            */}
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Workspace slug</span>
              <div
                className={cn(
                  "flex items-center overflow-hidden rounded-lg bg-muted px-2.5",
                  CONTROL_HEIGHT,
                )}
              >
                <code className="truncate font-mono text-xs text-muted-foreground">
                  {organization.slug}
                </code>
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                Fixed. It identifies this workspace in URLs and API calls.
              </p>
            </div>
          </CardContent>

          <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-[0.6875rem] text-muted-foreground">
              Changes apply to everyone in this workspace.
            </p>
            {/* type="button" so it can never submit a form it is nested inside. */}
            <Button type="button" className={cn("px-4", CONTROL_HEIGHT)}>
              Save changes
            </Button>
          </CardContent>
        </Card>
      </section>

      {/*
        Members runs edge to edge inside its card: `py-0` lets the table's own row
        rules reach the card's sides, which is what makes a list of people read as
        a register rather than as a stack of rows floating in padding.
      */}
      <section className="rise [animation-delay:120ms]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-1">
              <h2 className={EYEBROW}>Members</h2>
              <p className="text-[0.6875rem] text-muted-foreground">
                {memberCount === 1
                  ? "You are the only person with access to this workspace's data."
                  : `${formatCount(memberCount)} people have access to this workspace's data.`}
              </p>
            </div>
            <CardAction>
              <Button
                type="button"
                className={cn(
                  "bg-brand px-4 text-brand-foreground hover:bg-brand/90",
                  CONTROL_HEIGHT,
                )}
              >
                <UserPlus />
                Invite member
              </Button>
            </CardAction>
          </CardHeader>

          {memberCount === 0 ? (
            // Defensive, not expected: the caller is a member by definition, so
            // reaching this means the membership was revoked between the two
            // queries. It renders an explanation rather than an empty table.
            <EmptyState
              icon={Users}
              title="No members to show"
              description="This workspace has no memberships right now. Reload the page — your own access may have changed while this loaded."
              className="mx-4 my-4 border-0 bg-transparent py-10"
            />
          ) : (
            <Table>
              <TableCaption className="sr-only">
                People with access to {organization.name}, most privileged first.
              </TableCaption>

              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className={cn(TABLE_HEAD, "pl-4")}>Member</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>
                    Email
                  </TableHead>
                  <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>Role</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {members.map((member) => {
                  const displayName = formatPersonName(member.user.name, member.user.email);
                  const isViewer = member.user.id === session.user.id;

                  return (
                    <TableRow key={member.user.id} className="border-border">
                      <TableCell className="py-2.5 pl-4">
                        <div className="flex items-center gap-2.5">
                          {/*
                            Keeps the mono monogram voice the user menu
                            established and drops its brass. Two reasons: an
                            avatar carries IDENTITY, not status, so a column of
                            gold discs would spend the page's one accent on the
                            least meaningful thing in it — and `text-brand` on a
                            15% brand wash measures 2.7:1 in light, which is not
                            a ratio to repeat once per row.
                          */}
                          <Avatar size="sm">
                            {/* alt="" — the name is rendered immediately to the
                                right, so announcing it twice is noise. */}
                            {member.user.image ? (
                              <AvatarImage src={member.user.image} alt="" />
                            ) : null}
                            <AvatarFallback className="font-mono text-[0.6875rem] font-medium">
                              {formatInitials(displayName)}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex min-w-0 flex-col leading-tight">
                            <span className="flex min-w-0 items-baseline">
                              <span className="truncate font-medium text-foreground">
                                {displayName}
                              </span>
                              {isViewer ? (
                                <>
                                  <span
                                    aria-hidden
                                    className="px-1.5 text-muted-foreground/40"
                                  >
                                    ·
                                  </span>
                                  <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                                    you
                                  </span>
                                </>
                              ) : null}
                            </span>
                            {/* Below `sm` the email column is gone, so it rides
                                under the name instead of being dropped. */}
                            <span className="truncate font-mono text-[0.6875rem] text-muted-foreground sm:hidden">
                              {member.user.email}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                        {member.user.email}
                      </TableCell>

                      <TableCell className="py-2.5 pr-4 text-right">
                        <Badge
                          variant="secondary"
                          className={cn(ROLE_BADGE, ROLE_CLASS[member.role])}
                        >
                          {formatEnumLabel(member.role)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {/*
        The only card in the product with a non-neutral ring. Everything else uses
        `ring-foreground/10`; this one is rose so it reads as a different KIND of
        surface at a glance, without shouting — no filled red panel, no warning
        icon, no all-caps banner. The buttons carry the destructive variant, which
        is already the tinted-not-solid treatment, so the page never has a
        saturated red block sitting in it.
      */}
      <section className="rise [animation-delay:180ms]">
        <Card className="ring-destructive/25">
          <CardHeader>
            <h2 className={cn(EYEBROW, "text-destructive")}>Danger zone</h2>
          </CardHeader>

          <CardContent className="flex flex-col">
            {DANGER_ACTIONS.map((action) => (
              <div
                key={action.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 max-w-prose">
                  <h3 className="text-[0.8125rem] font-medium text-foreground">
                    {action.title}
                  </h3>
                  <p
                    id={`${action.id}-description`}
                    className="mt-0.5 text-[0.6875rem] text-muted-foreground text-balance"
                  >
                    {action.description}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {action.lockNote ? (
                    <span className="flex items-center gap-1 font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                      <Lock className="size-3" aria-hidden />
                      {action.lockNote}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={action.disabled}
                    aria-describedby={`${action.id}-description`}
                    className={cn("px-4", CONTROL_HEIGHT)}
                  >
                    {action.label}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
