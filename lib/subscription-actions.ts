"use server";

// "Add subscription" — records a real Subscription for one of the workspace's
// customers, creating the customer first when the form asks for a new one.
//
// File-level `"use server"`: the dialog that calls this is a client island, so
// this export is a public endpoint and everything in the FormData is untrusted.
// It exports ONLY the action; the schema and result shape live in
// lib/subscription-form.ts.
//
// Which workspace: the one the dialog was RENDERED for (a hidden field), checked
// by composite key against the caller's memberships — the same pattern as
// lib/workspace-actions.ts. The customer and the plan ids from the form are then
// looked up INSIDE that workspace, so an id belonging to another tenant matches
// nothing and is refused.
//
// Price terms are COPIED onto the subscription (amount, interval, intervalCount):
// repricing the plan later must not rewrite what this customer was charged. The
// amount is the plan's price unless the form gives a custom one.
//
// `previousSubscriptionId` stays null — this is not a plan change of an existing
// segment. No invoices are created. A success records an audit entry via
// `after()` — see lib/audit-writer.ts.
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { writeAudit } from "@/lib/audit-writer";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  CUSTOM_PRICE,
  NEW_CUSTOMER,
  billingOption,
  priceToCents,
  subscriptionFieldErrors,
  subscriptionSchema,
  type SubscriptionFieldErrors,
  type SubscriptionFormState,
} from "@/lib/subscription-form";

const STALE_PAGE = "This page is out of date. Reload it and try again.";

function failure(message: string): SubscriptionFormState {
  return { status: "error", message, fieldErrors: {} };
}

function fieldFailure(fieldErrors: SubscriptionFieldErrors): SubscriptionFormState {
  return { status: "error", message: null, fieldErrors };
}

export async function addSubscription(
  _previous: SubscriptionFormState,
  formData: FormData,
): Promise<SubscriptionFormState> {
  const session = await requireSession();

  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || organizationId === "") return failure(STALE_PAGE);

  // Composite primary key — a miss for any org the caller does not belong to.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: session.user.id, organizationId } },
    select: { role: true, organization: { select: { currency: true } } },
  });
  if (membership === null) return failure(STALE_PAGE);
  if (membership.role === "MEMBER") return failure("Only owners and admins can add subscriptions.");

  const parsed = subscriptionSchema.safeParse({
    customerId: formData.get("customerId"),
    newCustomerName: formData.get("newCustomerName"),
    planId: formData.get("planId"),
    price: formData.get("price"),
    billing: formData.get("billing"),
    status: formData.get("status"),
    startDate: formData.get("startDate"),
  });
  if (!parsed.success) return fieldFailure(subscriptionFieldErrors(parsed.error));
  const { customerId, newCustomerName, planId, price, billing, status, startDate } = parsed.data;

  // Both lookups are scoped to the workspace: an id from anywhere else is a miss.
  const existingCustomer =
    customerId === NEW_CUSTOMER
      ? null
      : await prisma.customer.findFirst({
          where: { id: customerId, organizationId, archivedAt: null },
          select: { id: true, name: true },
        });
  if (customerId !== NEW_CUSTOMER && existingCustomer === null) {
    return fieldFailure({ customerId: "That customer is no longer in this workspace. Reload and pick again." });
  }

  const plan =
    planId === CUSTOM_PRICE
      ? null
      : await prisma.plan.findFirst({
          where: { id: planId, organizationId, archivedAt: null },
          select: { id: true, name: true, amountCents: true, interval: true, intervalCount: true },
        });
  if (planId !== CUSTOM_PRICE && plan === null) {
    return fieldFailure({ planId: "That plan is no longer offered. Reload and pick again." });
  }

  // The schema guarantees a price and a billing option for a custom price.
  const terms =
    plan === null
      ? billingOption(billing ?? "MONTH_1")
      : { interval: plan.interval, intervalCount: plan.intervalCount };
  const amountCents = price === "" && plan !== null ? plan.amountCents : priceToCents(price);

  const { subscriptionId, customerName } = await prisma.$transaction(async (tx) => {
    const customer =
      existingCustomer ??
      (await tx.customer.create({
        data: { organizationId, name: newCustomerName, source: "MANUAL" },
        select: { id: true, name: true },
      }));
    const subscription = await tx.subscription.create({
      data: {
        organizationId,
        customerId: customer.id,
        planId: plan?.id ?? null,
        status,
        amountCents,
        quantity: 1,
        interval: terms.interval,
        intervalCount: terms.intervalCount,
        // UTC midnight of the chosen day — the boundary every metric and snapshot uses.
        startedAt: new Date(`${startDate}T00:00:00.000Z`),
        source: "MANUAL",
      },
      select: { id: true },
    });
    return { subscriptionId: subscription.id, customerName: customer.name };
  });

  const planName = plan?.name ?? "Custom";
  after(() =>
    writeAudit({
      organizationId,
      actorId: session.user.id,
      action: "subscription.created",
      targetType: "subscription",
      targetId: subscriptionId,
      targetLabel: `${customerName} · ${planName}`,
      metadata: {
        customer: customerName,
        plan: planName,
        amountCents,
        interval: terms.interval,
        intervalCount: terms.intervalCount,
        currency: membership.organization.currency,
        newCustomer: existingCustomer === null,
      },
    }),
  );

  // Layout scope: MRR moves on the overview, retention and customers pages too,
  // not only on /dashboard/revenue.
  revalidatePath("/dashboard", "layout");
  return { status: "success", message: null, fieldErrors: {} };
}
