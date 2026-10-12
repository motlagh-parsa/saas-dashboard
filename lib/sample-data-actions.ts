"use server";

// Sample data from inside the product: load it into a workspace to explore, and
// remove it again. The same generator the seed uses (lib/sample-data.ts), so a
// founder sees exactly what a reviewer of the demo sees — only in their own
// workspace and currency.
//
// File-level `"use server"`: every export is a public endpoint and the FormData
// is untrusted. Authorization is `billingWriter` (lib/billing-caller.ts): OWNER
// or ADMIN of the organization the control was rendered for, by composite key.
//
// Loading is refused when the workspace already has any billing data of its own
// (source ≠ SAMPLE): sample customers mixed into real ones would put invented
// revenue into a founder's real numbers, and "remove sample data" could no longer
// promise to leave exactly their data behind.
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { billingWriter } from "@/lib/billing-caller";
import type { BillingFormState } from "@/lib/billing-form";
import { prisma } from "@/lib/prisma";
import { generateSampleData, removeSampleData as deleteSampleRows } from "@/lib/sample-data";
import { evaluateAlerts } from "@/lib/alerts";
import { recomputeSnapshots } from "@/lib/snapshots";
import { countOwnBillingData } from "@/lib/workspace-status";

function refusal(message: string): BillingFormState {
  return { status: "error", message, fieldErrors: {} };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Rewrites the workspace's snapshots from its earliest subscription, if it has any. */
async function recomputeAll(organizationId: string): Promise<void> {
  const earliest = await prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { startedAt: "asc" },
    select: { startedAt: true },
  });
  if (earliest !== null) await recomputeSnapshots(organizationId, earliest.startedAt);
  // In-app only for sample data (lib/alerts.ts) — gives the feed something real.
  await evaluateAlerts(organizationId);
}

export async function loadSampleData(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;

  const own = await countOwnBillingData(caller.organizationId);
  const ownParts = [
    own.customers > 0 ? plural(own.customers, "customer") : null,
    own.plans > 0 ? plural(own.plans, "plan") : null,
    own.subscriptions > 0 ? plural(own.subscriptions, "subscription") : null,
    own.invoices > 0 ? plural(own.invoices, "invoice") : null,
  ].filter((part): part is string => part !== null);
  if (ownParts.length > 0) {
    return refusal(
      `This workspace already has its own billing data (${ownParts.join(", ")}). Sample data only goes into an empty workspace, so invented revenue never mixes with your real numbers — create a new workspace to explore it.`,
    );
  }
  const alreadyLoaded = await prisma.customer.count({
    where: { organizationId: caller.organizationId, source: "SAMPLE" },
  });
  if (alreadyLoaded > 0) return refusal("Sample data is already loaded in this workspace.");

  const summary = await generateSampleData(caller.organizationId);
  await recomputeAll(caller.organizationId);

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "sample_data.loaded",
      targetType: "workspace",
      targetId: caller.organizationId,
      metadata: {
        ...summary,
        detail: `${plural(summary.customers, "customer")}, ${plural(summary.subscriptions, "subscription")}, ${plural(summary.invoices, "invoice")}`,
      },
    }),
  );
  revalidatePath("/", "layout");
  return {
    status: "success",
    message: `${plural(summary.customers, "sample customer")} with 18 months of history.`,
    fieldErrors: {},
  };
}

/**
 * Deletes every SAMPLE row of the workspace — and only those — then rewrites the
 * snapshots from whatever real history remains (none, usually).
 */
export async function removeSampleData(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const check = await billingWriter(formData.get("organizationId"));
  if (!check.ok) return check.state;
  const { caller } = check;

  const removed = await deleteSampleRows(caller.organizationId);
  if (removed.subscriptions + removed.customers + removed.plans + removed.invoices === 0) {
    return refusal("There is no sample data in this workspace.");
  }
  await recomputeAll(caller.organizationId);

  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "sample_data.removed",
      targetType: "workspace",
      targetId: caller.organizationId,
      metadata: {
        ...removed,
        detail: `${plural(removed.customers, "customer")}, ${plural(removed.subscriptions, "subscription")}, ${plural(removed.invoices, "invoice")}`,
      },
    }),
  );
  revalidatePath("/", "layout");
  return { status: "success", message: "Sample data removed. Your workspace is empty again.", fieldErrors: {} };
}
