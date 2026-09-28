"use server";

// "Add subscription" — records a real Subscription row for a workspace.
//
// File-level `"use server"`: the dialog that calls this is a client island, so
// this export is a public endpoint and everything in the FormData is untrusted.
// It exports ONLY the action; the schema and result shape live in
// lib/subscription-form.ts.
//
// Which workspace: the one the dialog was RENDERED for (a hidden field), checked
// by composite key against the caller's memberships — the same pattern as
// lib/workspace-actions.ts. Resolving the active workspace afresh here would let
// a tab left open on workspace X add a subscription to Y after a switch
// elsewhere.
//
// What it writes is a NEW lifecycle: `previousSubscriptionId` stays null, so the
// metrics treat it as a new customer chain, not a plan change of an existing one
// (see the schema comment on that field). Every field it sets is an existing
// Subscription column; no invoices are created. A success records an audit entry
// via `after()` — see lib/audit-writer.ts.
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { formatEnumLabel } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  subscriptionFieldErrors,
  subscriptionSchema,
  type SubscriptionFormState,
} from "@/lib/subscription-form";

function failure(message: string): SubscriptionFormState {
  return { status: "error", message, fieldErrors: {} };
}

export async function addSubscription(
  _previous: SubscriptionFormState,
  formData: FormData,
): Promise<SubscriptionFormState> {
  const session = await requireSession();

  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || organizationId === "") {
    return failure("This page is out of date. Reload it and try again.");
  }

  // Composite primary key — a miss for any org the caller does not belong to.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true },
  });
  if (membership === null) {
    return failure("This page is out of date. Reload it and try again.");
  }
  if (membership.role === "MEMBER") {
    return failure("Only owners and admins can add subscriptions.");
  }

  const parsed = subscriptionSchema.safeParse({
    tier: formData.get("tier"),
    interval: formData.get("interval"),
    status: formData.get("status"),
    price: formData.get("price"),
    startDate: formData.get("startDate"),
  });
  if (!parsed.success) {
    return { status: "error", message: null, fieldErrors: subscriptionFieldErrors(parsed.error) };
  }
  const { tier, interval, status, price, startDate } = parsed.data;

  const created = await prisma.subscription.create({
    data: {
      organizationId,
      tier,
      interval,
      status,
      amountCents: price,
      // UTC midnight of the chosen day — the boundary every metric and snapshot uses.
      startedAt: new Date(`${startDate}T00:00:00.000Z`),
    },
    select: { id: true },
  });

  after(() =>
    writeAudit({
      organizationId,
      actorId: session.user.id,
      action: "subscription.created",
      targetType: "subscription",
      targetId: created.id,
      targetLabel: `${formatEnumLabel(tier)} ${formatEnumLabel(interval).toLowerCase()}`,
      metadata: { tier, interval, amountCents: price },
    }),
  );

  // Layout scope: MRR moves on the overview, retention and customers pages too,
  // not only on /dashboard/revenue.
  revalidatePath("/dashboard", "layout");
  return { status: "success", message: null, fieldErrors: {} };
}
