// Onboarding — where a new account becomes a working workspace. Render mode:
// dynamic (session and cookies). Lives in the (auth) group so it wears the same
// brand shell as sign-in and register: it is the last step of signing up, not a
// dashboard page.
//
// Which step, decided on the server every time — never by a query param a user
// could set:
//   - No workspace yet            -> Step 1, "Create your workspace".
//   - An active workspace that is still empty -> Step 2, "Bring your data", for
//     THAT workspace (e.g. just created from the switcher's dialog).
//   - The active workspace already has data, or the caller is a MEMBER who could
//     not set it up anyway -> straight to /dashboard. Onboarding is done.
//
// The dashboard layout sends anyone with no membership here, and registration
// lands here after signing the new user in.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, PencilLine } from "lucide-react";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { currencyOptions } from "@/lib/currencies";
import { prisma } from "@/lib/prisma";
import { getWorkspaceDataState } from "@/lib/workspace-status";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ImportSlot } from "@/components/billing/import-slot";
import { CreateWorkspaceForm } from "@/components/workspace/create-workspace-form";
import { LoadSampleDataButton } from "@/components/workspace/sample-data-controls";

export const metadata: Metadata = {
  title: "Set up your workspace",
  description: "Create a workspace and bring in your billing data.",
};

const STEPS = 2;

function Progress({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-3" data-testid="onboarding-progress">
      <div className="flex gap-1.5" aria-hidden>
        {Array.from({ length: STEPS }, (_, index) => (
          <span
            key={index}
            className={`h-1 w-8 rounded-full ${index < step ? "bg-brand" : "bg-border"}`}
          />
        ))}
      </div>
      <p className="font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Step {step} of {STEPS}
      </p>
    </div>
  );
}

export default async function OnboardingPage() {
  const session = await requireSession();
  const organizationId = await getActiveOrgId(session.user.id);

  // ---- Step 1: no workspace yet --------------------------------------------
  if (organizationId === null) {
    return (
      <div className="w-full max-w-md">
        <Progress step={1} />
        <div className="mt-5 flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="text-sm text-muted-foreground">
            A workspace holds one business&apos;s customers, plans and metrics. You can invite your team to it later.
          </p>
        </div>
        <div className="mt-6">
          <CreateWorkspaceForm currencies={currencyOptions()} size="page" />
        </div>
        {/* Nothing to skip to without a workspace — but never a dead end. */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Signed in as {session.user.email}</span>
          <SignOutButton variant="ghost" size="sm" showIcon={false} className="h-8 px-2 text-xs">
            Sign out
          </SignOutButton>
        </div>
      </div>
    );
  }

  const [membership, dataState] = await Promise.all([
    prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: session.user.id, organizationId } },
      select: { role: true, organization: { select: { name: true, currency: true } } },
    }),
    getWorkspaceDataState(organizationId),
  ]);

  // Already set up, or not theirs to set up: onboarding is over.
  if (dataState.hasBillingData || membership.role === "MEMBER") redirect("/dashboard");

  const { organization } = membership;

  // ---- Step 2: bring your data ---------------------------------------------
  return (
    <div className="w-full max-w-2xl">
      <Progress step={2} />
      <div className="mt-5 flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Bring your data</h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{organization.name}</span> is ready, reporting in{" "}
          {organization.currency}. How do you want to start?
        </p>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href="/dashboard/plans?action=create"
          className="group flex h-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 outline-none transition-colors hover:border-brand/60 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-brand/20">
            <PencilLine aria-hidden className="size-5" />
          </span>
          <span className="font-heading text-base font-semibold tracking-tight">Add it yourself</span>
          <span className="text-sm text-muted-foreground">
            Plans come first, then customers and their subscriptions. Past start dates are fine, so you can enter
            your history.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
            Create your first plan
            <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>

        <LoadSampleDataButton organizationId={organizationId} then="dashboard" appearance="card">
          <span className="font-heading text-base font-semibold tracking-tight">Explore with sample data</span>
          <span className="text-sm text-muted-foreground">
            60 customers and 18 months of subscriptions, plan changes, churn and invoices, in{" "}
            {organization.currency}. Remove it in one click when you are ready for your own.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
            Load sample data
            <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </LoadSampleDataButton>

        {/* "Import a CSV" and "Connect via API" land here once they exist. */}
        <ImportSlot />
      </div>

      <p className="mt-6 text-sm">
        <Link href="/dashboard" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Skip to dashboard
        </Link>
      </p>
    </div>
  );
}
