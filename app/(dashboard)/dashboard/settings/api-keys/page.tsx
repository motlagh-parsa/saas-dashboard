// Settings → API keys. Render mode: dynamic — it reads the session cookie.
//
// OWNER and ADMIN only: members are not shown the tab, and reaching the URL
// anyway renders a refusal here (the actions in lib/api-key-actions.ts refuse
// them too). The workspace is resolved server-side (lib/active-org.ts) and every
// query is scoped to it.
//
// Lists every key the workspace ever made — revoked and expired ones stay, so
// the audit trail's "API · <key name>" entries always have a row to point at.
// The key itself is never here: only its prefix. It was shown once, in the
// create dialog.
import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, Building2, KeyRound, ShieldAlert } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { MAX_ACTIVE_KEYS } from "@/lib/api/keys";
import { API_DOCS_PATH } from "@/lib/api-key-form";
import { requireSession } from "@/lib/auth";
import { EM_DASH, formatDay, formatPersonName, formatRelativeTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
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
import { SettingsTabs } from "@/components/dashboard/settings-tabs";
import { CreateApiKeyDialog, RevokeApiKeyDialog } from "@/components/settings/api-key-dialogs";

export const metadata: Metadata = {
  title: "API keys",
  description: "Keys your backend uses to push billing data into Meridian and read metrics.",
};

const EYEBROW = "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";
const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";
const BADGE = "font-mono text-[0.625rem] font-medium tracking-[0.12em] uppercase";

type KeyStatus = "active" | "expired" | "revoked";

const STATUS_CLASS: Record<KeyStatus, string> = {
  active: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  expired: "bg-muted text-muted-foreground",
  revoked: "bg-destructive/10 text-destructive",
};

export default async function ApiKeysPage() {
  const session = await requireSession();
  const organizationId = await getActiveOrgId(session.user.id);
  const membership =
    organizationId === null
      ? null
      : await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: session.user.id, organizationId } },
          select: { role: true, organization: { select: { name: true } } },
        });

  if (organizationId === null || membership === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="API keys belong to a workspace. Create one to get started."
          action={
            <Button asChild className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
              <Link href="/onboarding">Create workspace</Link>
            </Button>
          }
          className="rise mt-2"
        />
      </main>
    );
  }

  const canManage = membership.role !== "MEMBER";
  const header = (
    <header className="rise flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">API keys</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">{membership.organization.name}</p>
      </div>
      <SettingsTabs current="api-keys" showApiKeys={canManage} />
    </header>
  );

  if (!canManage) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {header}
        <EmptyState
          icon={ShieldAlert}
          title="Only owners and admins manage API keys"
          description="Ask an owner or admin of this workspace if your backend needs a key."
          className="rise mt-3"
        />
      </main>
    );
  }

  const now = new Date();
  const keys = await prisma.apiKey.findMany({
    where: { organizationId },
    orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      prefix: true,
      scope: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdBy: { select: { name: true, email: true } },
    },
  });
  const statusOf = (key: (typeof keys)[number]): KeyStatus =>
    key.revokedAt !== null ? "revoked" : key.expiresAt !== null && key.expiresAt <= now ? "expired" : "active";
  const activeCount = keys.filter((key) => statusOf(key) === "active").length;
  const atLimit = activeCount >= MAX_ACTIVE_KEYS;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {header}

      <section className="rise mt-3 [animation-delay:60ms]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <div className="flex flex-col gap-1">
              <h2 className={EYEBROW}>Keys</h2>
              <p className="max-w-prose text-[0.8125rem] text-muted-foreground">
                Your backend pushes customers, plans, subscriptions and invoices to Meridian as they change, and reads
                metrics back.{" "}
                <Link href={API_DOCS_PATH} className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
                  <BookOpen aria-hidden className="size-3.5" />
                  API documentation
                </Link>
              </p>
              <p className="text-[0.6875rem] text-muted-foreground">
                {activeCount} of {MAX_ACTIVE_KEYS} active
                {atLimit ? " — revoke a key to create another." : ""}
              </p>
            </div>
            <CardAction>
              <CreateApiKeyDialog organizationId={organizationId} atLimit={atLimit} />
            </CardAction>
          </CardHeader>

          {keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create a key for your backend. It is shown once, so have somewhere to store it."
              className="mx-4 my-4 border-0 bg-transparent py-10"
            />
          ) : (
            <Table>
              <TableCaption className="sr-only">API keys of {membership.organization.name}, active first.</TableCaption>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className={cn(TABLE_HEAD, "pl-4")}>Key</TableHead>
                  <TableHead className={TABLE_HEAD}>Access</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "hidden md:table-cell")}>Created</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>Last used</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "hidden lg:table-cell")}>Expires</TableHead>
                  <TableHead className={TABLE_HEAD}>Status</TableHead>
                  <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => {
                  const status = statusOf(key);
                  const creator = key.createdBy ? formatPersonName(key.createdBy.name, key.createdBy.email) : "Former member";
                  return (
                    <TableRow key={key.id} className="border-border" data-testid="api-key-row">
                      <TableCell className="py-2.5 pl-4">
                        <div className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate font-medium text-foreground">{key.name}</span>
                          <span className="font-mono text-[0.6875rem] text-muted-foreground">{key.prefix}…</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 text-xs">{key.scope === "WRITE" ? "Read and write" : "Read only"}</TableCell>
                      <TableCell className="hidden py-2.5 text-xs text-muted-foreground md:table-cell">
                        {formatDay(key.createdAt)}
                        <span className="block text-[0.6875rem]">by {creator}</span>
                      </TableCell>
                      <TableCell className="hidden py-2.5 text-xs text-muted-foreground sm:table-cell">
                        {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt, now) : "Never"}
                      </TableCell>
                      <TableCell className="hidden py-2.5 text-xs text-muted-foreground lg:table-cell">
                        {key.expiresAt ? formatDay(key.expiresAt) : "Never"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge variant="secondary" className={cn(BADGE, STATUS_CLASS[status])}>
                          {status}
                        </Badge>
                        {status === "revoked" && key.revokedAt ? (
                          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{formatDay(key.revokedAt)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="py-2.5 pr-4 text-right">
                        {status === "revoked" ? (
                          <span className="text-muted-foreground">{EM_DASH}</span>
                        ) : (
                          <RevokeApiKeyDialog organizationId={organizationId} keyId={key.id} name={key.name} prefix={key.prefix} />
                        )}
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
