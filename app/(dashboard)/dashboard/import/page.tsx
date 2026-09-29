// Import. Render mode: dynamic — it reads the session cookie and query params.
//
// Bring existing billing data in from a CSV — a Stripe, Paddle or Chargebee
// export, or a spreadsheet: the wizard (components/import/import-wizard.tsx) and
// the workspace's recent imports.
//
// OWNER and ADMIN only: a MEMBER is sent back to the overview (the audit log's
// rule), and every import action refuses them on the server regardless.
//
// `maxDuration` covers the Server Actions this page calls: an import of 20,000
// rows is written in chunks of 500 and can take a while.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { formatDay, formatPersonName } from "@/lib/format";
import { IMPORT_KIND_KEYS, type ImportKindKey } from "@/lib/import/kinds";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ImportHistory, type ImportRunRow } from "@/components/import/import-history";
import { ImportWizard } from "@/components/import/import-wizard";

export const maxDuration = 300;

export const metadata: Metadata = {
  title: "Import",
  description: "Bring your customers, plans, subscriptions and invoices in from a CSV.",
};

const HISTORY_LIMIT = 20;

interface ImportPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ImportPage({ searchParams }: ImportPageProps) {
  const session = await requireSession();
  const params = await searchParams;
  const rawKind = Array.isArray(params.kind) ? params.kind[0] : params.kind;
  const initialKind = IMPORT_KIND_KEYS.find((key): key is ImportKindKey => key === rawKind);

  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Imports go into a workspace. Create one to get started, or ask an owner to invite you to theirs."
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

  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true, organization: { select: { name: true, currency: true } } },
  });
  if (membership.role === "MEMBER") redirect("/dashboard");

  const runs = await prisma.importRun.findMany({
    where: { organizationId },
    orderBy: { startedAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      kind: true,
      fileName: true,
      status: true,
      totalRows: true,
      created: true,
      updated: true,
      unchanged: true,
      errorCount: true,
      startedAt: true,
      startedBy: { select: { name: true, email: true } },
    },
  });
  const rows: ImportRunRow[] = runs.map((run) => ({
    id: run.id,
    kind: run.kind,
    fileName: run.fileName,
    status: run.status,
    totalRows: run.totalRows,
    created: run.created,
    updated: run.updated,
    unchanged: run.unchanged,
    errorCount: run.errorCount,
    startedLabel: formatDay(run.startedAt),
    startedBy: run.startedBy ? formatPersonName(run.startedBy.name, run.startedBy.email) : "a deleted user",
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Import</h1>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {membership.organization.name}
          <span aria-hidden className="px-1.5 text-muted-foreground/40">
            ·
          </span>
          from Stripe, Paddle, Chargebee or a spreadsheet, into {membership.organization.currency}
        </p>
      </header>
      <section className="rise mt-3 [animation-delay:60ms]">
        <ImportWizard
          key={organizationId}
          organizationId={organizationId}
          currency={membership.organization.currency}
          initialKind={initialKind}
        />
      </section>
      <section className="rise [animation-delay:120ms]">
        <ImportHistory organizationId={organizationId} runs={rows} />
      </section>
    </main>
  );
}
