// Settings → Integrations: connecting the workspace's Stripe account.
// Render mode: dynamic — it reads the session cookie.
//
// OWNER and ADMIN only, like API keys: members aren't shown the tab, and the
// URL renders a refusal for them (lib/stripe-actions.ts refuses them too). The
// workspace is resolved server-side; nothing secret reaches the page — the key
// and the signing secret are encrypted in the database and only their presence
// (and the key's last four characters) are shown.
import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ShieldAlert } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { formatRelativeTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { HANDLED_EVENTS } from "@/lib/stripe/webhook";
import type { SyncKind, SyncSummary } from "@/lib/stripe/sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SettingsTabs } from "@/components/dashboard/settings-tabs";
import {
  ConnectStripeForm,
  DisconnectStripeDialog,
  SyncNowButton,
  WebhookSecretForm,
} from "@/components/settings/stripe-forms";

export const metadata: Metadata = {
  title: "Integrations",
  description: "Connect Stripe to keep your billing data in sync.",
};

const EYEBROW = "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";
const KINDS: readonly { kind: SyncKind; label: string }[] = [
  { kind: "plans", label: "Plans" },
  { kind: "customers", label: "Customers" },
  { kind: "subscriptions", label: "Subscriptions" },
  { kind: "invoices", label: "Invoices" },
];

export default async function IntegrationsPage() {
  const session = await requireSession();
  const organizationId = await getActiveOrgId(session.user.id);
  const membership =
    organizationId === null
      ? null
      : await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: session.user.id, organizationId } },
          select: { role: true, organization: { select: { name: true, currency: true } } },
        });

  if (organizationId === null || membership === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Integrations belong to a workspace. Create one to get started."
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
        <h1 className="font-heading text-xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">{membership.organization.name}</p>
      </div>
      <SettingsTabs current="integrations" showManagerTabs={canManage} />
    </header>
  );

  if (!canManage) {
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {header}
        <EmptyState
          icon={ShieldAlert}
          title="Only owners and admins manage integrations"
          description="Ask an owner or admin of this workspace to connect Stripe."
          className="rise mt-3"
        />
      </main>
    );
  }

  const connection = await prisma.stripeConnection.findUnique({
    where: { organizationId },
    select: {
      id: true,
      keyHint: true,
      livemode: true,
      syncState: true,
      lastSyncAt: true,
      lastSyncSummary: true,
      lastSyncError: true,
      lastWebhookAt: true,
      encryptedWebhookSecret: true,
      createdAt: true,
    },
  });
  const now = new Date();
  const summary = (connection?.lastSyncSummary ?? null) as SyncSummary | null;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {header}

      <section className="rise mt-3 [animation-delay:60ms]" data-testid="stripe-card">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-1">
              <h2 className={EYEBROW}>Stripe</h2>
              <p className="text-[0.8125rem] text-muted-foreground">
                Customers, prices, subscriptions and invoices from your Stripe account, kept in sync. Meridian only
                reads from Stripe; it never changes anything there.
              </p>
            </div>
            {connection ? (
              <CardAction>
                <SyncNowButton organizationId={organizationId} running={connection.syncState === "running"} />
              </CardAction>
            ) : null}
          </CardHeader>

          {connection === null ? (
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <ol className="flex list-decimal flex-col gap-2 pl-5 text-[0.8125rem] leading-relaxed text-foreground/90">
                <li>
                  In Stripe, open <span className="font-medium">Developers → API keys</span> and choose{" "}
                  <span className="font-medium">Create restricted key</span>.
                </li>
                <li>
                  Give it <span className="font-medium">Read</span> access to Customers, Products, Prices, Subscriptions
                  and Invoices. Leave everything else at None.
                </li>
                <li>Paste the key here. Meridian checks it can read each of those before saving it.</li>
                <li>
                  Amounts in {membership.organization.currency} are synced; prices in other currencies are listed as
                  skipped.
                </li>
              </ol>
              <ConnectStripeForm organizationId={organizationId} />
            </CardContent>
          ) : (
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
                <Badge variant="secondary" className={connection.livemode ? "bg-positive/12 text-positive" : "bg-muted text-muted-foreground"}>
                  {connection.livemode ? "Live mode" : "Test mode"}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">rk_…{connection.keyHint}</span>
                <span className="text-muted-foreground" data-testid="stripe-sync-status">
                  {connection.syncState === "running"
                    ? "Syncing now…"
                    : connection.lastSyncAt
                      ? `Last synced ${formatRelativeTime(connection.lastSyncAt, now)}`
                      : "Not synced yet"}
                </span>
              </div>
              {connection.lastSyncError ? (
                <p role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
                  {connection.lastSyncError}
                </p>
              ) : null}
              {summary ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-[0.8125rem]" data-testid="stripe-sync-summary">
                    <caption className="sr-only">What the last sync did</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-2 font-medium"> </th>
                        <th scope="col" className="py-2 text-right font-medium">Added</th>
                        <th scope="col" className="py-2 text-right font-medium">Updated</th>
                        <th scope="col" className="py-2 text-right font-medium">Unchanged</th>
                        <th scope="col" className="py-2 text-right font-medium">Skipped</th>
                      </tr>
                    </thead>
                    <tbody>
                      {KINDS.map(({ kind, label }) => {
                        const counts = summary.counts[kind];
                        return (
                          <tr key={kind} className="border-b border-border last:border-b-0">
                            <th scope="row" className="py-2 text-left font-medium">{label}</th>
                            <td className="py-2 text-right font-mono tabular-nums">{counts.created}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{counts.updated}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{counts.unchanged}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{counts.skipped}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {summary && summary.problems.length > 0 ? (
                <details className="text-[0.8125rem]">
                  <summary className="cursor-pointer text-muted-foreground">Why some were skipped</summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {summary.problems.map((problem) => (
                      <li key={`${problem.kind}:${problem.id}`}>
                        <span className="font-mono text-xs">{problem.id}</span>{" "}
                        <span className="text-muted-foreground">— {problem.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="text-xs text-muted-foreground">Meridian also syncs every night, in case a change was missed.</p>
            </CardContent>
          )}
        </Card>
      </section>

      {connection ? (
        <>
          <section className="rise [animation-delay:120ms]" data-testid="stripe-webhook-card">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-1">
                  <h2 className={EYEBROW}>Live updates</h2>
                  <p className="text-[0.8125rem] text-muted-foreground">
                    {connection.encryptedWebhookSecret
                      ? connection.lastWebhookAt
                        ? `Receiving changes from Stripe. Last one ${formatRelativeTime(connection.lastWebhookAt, now)}.`
                        : "Signing secret saved. Waiting for the first event from Stripe."
                      : "Without a webhook, changes reach Meridian with the nightly sync. Add one to get them within seconds."}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="grid gap-6 lg:grid-cols-2">
                <div className="flex flex-col gap-3 text-[0.8125rem]">
                  <p>
                    In Stripe, open <span className="font-medium">Developers → Webhooks → Add endpoint</span>, use this
                    URL, and select these events:
                  </p>
                  <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="stripe-webhook-url">
                    {appUrl()}/api/stripe/webhook/{connection.id}
                  </code>
                  <ul className="flex flex-wrap gap-1.5">
                    {HANDLED_EVENTS.map((event) => (
                      <li key={event} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
                        {event}
                      </li>
                    ))}
                  </ul>
                </div>
                <WebhookSecretForm organizationId={organizationId} saved={connection.encryptedWebhookSecret !== null} />
              </CardContent>
            </Card>
          </section>

          <section className="rise [animation-delay:180ms]">
            <Card className="ring-destructive/25">
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="max-w-prose">
                  <h2 className="text-[0.8125rem] font-medium">Disconnect Stripe</h2>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                    Stops syncing and deletes the stored key. The data already synced stays.
                  </p>
                </div>
                <DisconnectStripeDialog organizationId={organizationId} />
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}
    </main>
  );
}
