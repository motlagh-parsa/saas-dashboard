// Audit log. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware blocks anonymous
//      requests, but middleware alone is NOT authz, so it is re-checked here.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. OWNER and ADMIN only. A MEMBER is sent back to the overview — the log
//      names who changed whose access, which is an administrator's record.
//   4. The latest 100 entries, one query, awaited directly — the settings
//      page's reasoning: one dependent chain, nothing worth streaming.
//
// Read-only. Entries are written by lib/audit-writer.ts from the actions that
// change users, roles, workspaces and subscriptions.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ScrollText } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { auditActionLabel, auditActorLabel, auditDetails } from "@/lib/audit-view";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  EM_DASH,
  formatCount,
  formatDay,
  formatEnumLabel,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
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

export const metadata: Metadata = {
  title: "Audit Log",
  description: "Who changed users, roles, the workspace, and billing — and when.",
};

/** How far back the page reads. Older entries stay stored, just not listed. */
const ENTRY_LIMIT = 100;

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Full timestamp for the hover title — the relative label alone cannot be audited. */
const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export default async function AuditLogPage() {
  const session = await requireSession();

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  const organizationId = await getActiveOrgId(session.user.id);

  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="The audit log is scoped to a workspace. Create one to get started, or ask an owner to invite you to theirs."
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

  // The caller's role here, and the workspace name for the header — one row, by
  // composite key.
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true, organization: { select: { name: true } } },
  });
  if (membership.role === "MEMBER") {
    redirect("/dashboard");
  }

  // Served by the `[organizationId, createdAt]` index.
  const entries = await prisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: ENTRY_LIMIT,
    include: { actor: { select: { id: true, name: true, email: true } }, apiKey: { select: { name: true } } },
  });

  // One instant for the whole list, so the labels cannot drift mid-render.
  const now = new Date();

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Audit Log</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {membership.organization.name}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          as of {formatDay(now)}
        </p>
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-1">
              <h2 className={EYEBROW}>Activity</h2>
              <p className="text-[0.6875rem] text-muted-foreground text-balance">
                Changes to users, roles, this workspace and its subscriptions, newest first.
              </p>
            </div>
            <CardAction>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {entries.length === ENTRY_LIMIT
                  ? `Latest ${formatCount(ENTRY_LIMIT)}`
                  : `${formatCount(entries.length)} ${entries.length === 1 ? "entry" : "entries"}`}
              </span>
            </CardAction>
          </CardHeader>

          {entries.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="Nothing recorded yet"
              description="Adding, editing, suspending or deleting users, changing roles, renaming the workspace and adding subscriptions all land here as they happen."
              className="mx-4 my-4 border-0 bg-transparent py-10"
            />
          ) : (
            <Table>
              <TableCaption className="sr-only">
                Audit entries for {membership.organization.name}: when each change happened,
                who made it, what they did, what it applied to, and the details.
              </TableCaption>

              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className={cn(TABLE_HEAD, "pl-4")}>Time</TableHead>
                  <TableHead className={TABLE_HEAD}>Actor</TableHead>
                  <TableHead className={TABLE_HEAD}>Action</TableHead>
                  <TableHead className={TABLE_HEAD}>Target</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "hidden pr-4 md:table-cell")}>
                    Details
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {entries.map((entry) => {
                  const details = auditDetails(entry.action, entry.metadata);
                  return (
                    <TableRow key={entry.id} className="border-border">
                      <TableCell className="py-2.5 pl-4 font-mono text-xs whitespace-nowrap text-muted-foreground">
                        <time
                          dateTime={entry.createdAt.toISOString()}
                          title={`${timestampFormatter.format(entry.createdAt)} UTC`}
                        >
                          {formatRelativeTime(entry.createdAt, now)}
                        </time>
                      </TableCell>

                      <TableCell className="py-2.5">
                        {entry.actor || entry.apiKey ? (
                          <span className="font-medium text-foreground">{auditActorLabel(entry, "System")}</span>
                        ) : (
                          <span className="text-muted-foreground">System</span>
                        )}
                      </TableCell>

                      <TableCell className="py-2.5 whitespace-nowrap">
                        {auditActionLabel(entry.action)}
                      </TableCell>

                      <TableCell className="py-2.5">
                        <div className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate text-foreground">
                            {entry.targetLabel ?? EM_DASH}
                          </span>
                          <span className="font-mono text-[0.6875rem] text-muted-foreground">
                            {formatEnumLabel(entry.targetType)}
                          </span>
                          {/* Below `md` the Details column is gone, so it rides
                              under the target instead of being dropped. */}
                          {details !== EM_DASH ? (
                            <span className="text-[0.6875rem] text-muted-foreground md:hidden">
                              {details}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="hidden py-2.5 pr-4 text-xs text-muted-foreground md:table-cell">
                        {details}
                      </TableCell>
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
