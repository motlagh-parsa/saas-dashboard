// Plans. Render mode: dynamic — it reads the session cookie and query params.
//
// The workspace's price list: every plan with its price and interval, how many
// subscriptions are on it right now and the MRR they bring in. Owners and admins
// create, edit, archive and delete plans here; members see it read-only.
//
// Data flow: `requireSession()` (authz), the active workspace from
// lib/active-org.ts, every query param narrowed by lib/list-state.ts and
// lib/plan-list.ts, then one page of rows from lib/plan-query.ts.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Tags } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { formatCount } from "@/lib/format";
import { listHref, parseListState, totalPages } from "@/lib/list-state";
import { PLAN_LIST, parsePlanFilter, planExtras } from "@/lib/plan-list";
import { getPlanPage } from "@/lib/plan-query";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PlanFormDialog } from "@/components/billing/plan-dialogs";
import { PlansTable, type PlanTableRow } from "@/components/billing/plans-table";
import { ImportSlot } from "@/components/billing/import-slot";

export const metadata: Metadata = {
  title: "Plans",
  description: "The prices your workspace sells at, and the MRR each one brings in.",
};

interface PlansPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlansPage({ searchParams }: PlansPageProps) {
  const session = await requireSession();
  const params = await searchParams;

  const state = parseListState(PLAN_LIST, params);
  const filter = parsePlanFilter(params.status);
  // `?action=create` — where the ⌘K palette's "Create plan", onboarding and the empty states land.
  const openAdd = params.action === "create";

  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <EmptyState
          icon={Building2}
          title="You are not in a workspace yet"
          description="Plans belong to a workspace. Create one to get started, or ask an owner to invite you to theirs."
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

  const [membership, page] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { name: true, currency: true } } },
    }),
    getPlanPage(organizationId, { ...state, filter }),
  ]);
  const { organization } = membership;
  const canWrite = membership.role !== "MEMBER";

  const lastPage = totalPages(page.matching, state.perPage);
  if (state.page > lastPage) {
    redirect(listHref(PLAN_LIST, { ...state, page: lastPage }, planExtras(filter)));
  }

  const createDialog = canWrite ? (
    <PlanFormDialog
      key={openAdd ? "add" : "idle"}
      organizationId={organizationId}
      currency={organization.currency}
      openOnMount={openAdd}
    />
  ) : null;

  const rows: PlanTableRow[] = page.rows.map((row) => ({ ...row }));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Plans</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {organization.name}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            {formatCount(page.total)} {page.total === 1 ? "plan" : "plans"} in {organization.currency}
          </p>
        </div>
        {page.total > 0 ? createDialog : null}
      </header>

      {page.total === 0 ? (
        <>
          <EmptyState
            icon={Tags}
            title="No plans yet"
            description={
              canWrite
                ? "A plan is a price you sell at — say Starter at 29 a month, or Pro at 490 a year. Create your plans, then add customers' subscriptions on them. Custom-priced deals don't need a plan."
                : "This workspace has no plans yet. An owner or admin creates them here."
            }
            action={createDialog ?? undefined}
            className="rise mt-3"
          />
          <ImportSlot />
        </>
      ) : (
        <section className="rise mt-3 [animation-delay:60ms]">
          <PlansTable
            key={organizationId}
            organizationId={organizationId}
            currency={organization.currency}
            rows={rows}
            matching={page.matching}
            state={state}
            filter={filter}
            canWrite={canWrite}
          />
        </section>
      )}
    </main>
  );
}
