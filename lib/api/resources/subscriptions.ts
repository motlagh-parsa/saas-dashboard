import "server-only";

// /v1/subscriptions — the caller pushes a subscription's CURRENT state and this
// works out which lifecycle operations get Meridian there. Each one is the UI's
// own (lib/billing-ops.ts): Create, Change plan / quantity, Cancel, Undo
// cancellation, Correct (status only), Delete. Nothing here re-implements a
// billing rule — anything the UI would refuse comes back as a 409 carrying the
// UI's message.
//
// PUT, for an external_id Meridian has not seen: Create (plus Cancel when an
// end_date is sent). For one it has, in this order:
//   1. a scheduled cancellation the body no longer matches is undone;
//   2. differing plan / price / quantity -> Change, effective `effective_date`
//      (default today), exactly as the Change plan dialog;
//   3. a differing live status -> Correct of the current terms' status;
//   4. an end_date not yet in effect -> Cancel (today or earlier: canceled;
//      later: scheduled).
// Every refusal that can be known before writing is checked before step 1, so
// a PUT is refused whole rather than applied half-way.
import type { BillingInterval } from "@prisma/client";
import { z } from "zod";

import { CUSTOM_PRICE, LIVE_STATUSES, dayToDate, todayUtc } from "@/lib/billing-form";
import {
  cancelSubscriptionOp,
  changeSubscriptionOp,
  correctSubscriptionOp,
  createSubscriptionOp,
  deleteSubscriptionChainOp,
  undoScheduledCancelOp,
} from "@/lib/billing-ops";
import { formatDay } from "@/lib/format";
import { prisma } from "@/lib/prisma";

import { applied, type ApiWriteContext } from "../context";
import { conflict, notFound, parseBody } from "../errors";
import {
  amountSchema,
  checkIntervalCount,
  daySchema,
  externalIdSchema,
  intervalCountSchema,
  intervalSchema,
  pageParams,
  quantitySchema,
  type ListBody,
} from "../schema";
import {
  SEGMENT_SELECT,
  chainsOf,
  findChain,
  segmentExternalId,
  subscriptionWire,
  type Segment,
  type SubscriptionWire,
} from "./chains";

export type SubscriptionChange =
  | "created"
  | "plan_changed"
  | "quantity_changed"
  | "status_changed"
  | "canceled"
  | "cancel_scheduled"
  | "cancel_undone"
  | "unchanged";

const liveStatusSchema = z
  .enum(["active", "trialing", "past_due"], {
    error: "Use active, trialing or past_due. To cancel, send end_date.",
  })
  .transform((value) => value.toUpperCase() as (typeof LIVE_STATUSES)[number]);

const putSchema = z
  .strictObject({
    customer_external_id: externalIdSchema,
    plan_external_id: externalIdSchema.optional(),
    /** With a plan: a price override (a discount). Without: the custom price. */
    amount: amountSchema({ allowZero: true }).optional(),
    interval: intervalSchema.optional(),
    interval_count: intervalCountSchema.optional(),
    quantity: quantitySchema.optional(),
    status: liveStatusSchema.optional(),
    start_date: daySchema(),
    end_date: daySchema().nullable().optional(),
    effective_date: daySchema().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.plan_external_id !== undefined) {
      if (values.interval !== undefined) {
        ctx.addIssue({ code: "custom", path: ["interval"], message: "A plan sets the interval; send interval only with a custom amount." });
      }
      if (values.interval_count !== undefined) {
        ctx.addIssue({ code: "custom", path: ["interval_count"], message: "A plan sets the interval; send interval_count only with a custom amount." });
      }
    } else {
      if (values.amount === undefined) {
        ctx.addIssue({ code: "custom", path: ["plan_external_id"], message: "Send plan_external_id, or amount and interval for a custom price." });
      }
      if (values.interval === undefined) {
        ctx.addIssue({ code: "custom", path: ["interval"], message: "A custom price needs an interval (month or year)." });
      } else if (values.interval_count !== undefined) {
        checkIntervalCount(values.interval, values.interval_count, ctx, ["interval_count"]);
      }
    }
    if (values.end_date && values.end_date <= values.start_date) {
      ctx.addIssue({ code: "custom", path: ["end_date"], message: "end_date must be after start_date." });
    }
  });

type PutInput = z.output<typeof putSchema>;

/** The Change dialog's fields for the desired terms, and how they differ from `current`. */
interface DesiredTerms {
  readonly planId: string;
  readonly price: number | null;
  readonly interval: BillingInterval | null;
  readonly intervalCount: number | null;
  readonly quantity: number;
  readonly planChanged: boolean;
  readonly quantityChanged: boolean;
}

async function planIdOf(ctx: ApiWriteContext, externalId: string): Promise<string> {
  const plan = await prisma.plan.findUnique({
    where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId } },
    select: { id: true },
  });
  if (plan === null) throw notFound(`No plan with external_id ${externalId}. PUT /v1/plans/${externalId} first.`, "plan_external_id");
  return plan.id;
}

async function desiredTerms(ctx: ApiWriteContext, input: PutInput, current: Segment): Promise<DesiredTerms> {
  const quantity = input.quantity ?? current.quantity;
  const quantityChanged = quantity !== current.quantity;
  if (input.plan_external_id !== undefined) {
    const planId = await planIdOf(ctx, input.plan_external_id);
    if (planId === current.planId) {
      // Same plan: the price the subscription already has stands unless one is
      // sent — a plan repriced since must not move an existing subscription.
      const price = input.amount ?? current.amountCents;
      return { planId, price, interval: null, intervalCount: null, quantity, planChanged: price !== current.amountCents, quantityChanged };
    }
    return { planId, price: input.amount ?? null, interval: null, intervalCount: null, quantity, planChanged: true, quantityChanged };
  }
  const amount = input.amount ?? 0;
  const interval = input.interval ?? "MONTH";
  const intervalCount = input.interval_count ?? 1;
  const planChanged =
    current.planId !== null ||
    amount !== current.amountCents ||
    interval !== current.interval ||
    intervalCount !== current.intervalCount;
  return { planId: CUSTOM_PRICE, price: amount, interval, intervalCount, quantity, planChanged, quantityChanged };
}

const CHANGE_PARAMS = {
  planId: "plan_external_id",
  price: "amount",
  interval: "interval",
  intervalCount: "interval_count",
  quantity: "quantity",
  effectiveDate: "effective_date",
};

export interface SubscriptionPutResult {
  readonly created: boolean;
  readonly record: SubscriptionWire & { readonly changes: readonly SubscriptionChange[] };
}

async function reload(ctx: ApiWriteContext, externalId: string): Promise<Segment[]> {
  const chain = await findChain(ctx.organizationId, externalId);
  if (chain === null) throw notFound(`No subscription with external_id ${externalId}.`, "external_id");
  return chain;
}

export async function putSubscription(
  ctx: ApiWriteContext,
  externalId: string,
  body: unknown,
): Promise<SubscriptionPutResult> {
  const input = parseBody(putSchema, body, (raw) => {
    if (raw.plan_external_id !== undefined) return [];
    const missing = [];
    if (raw.amount === undefined) {
      missing.push({ param: "plan_external_id", message: "Send plan_external_id, or amount and interval for a custom price." });
    }
    if (raw.interval === undefined) missing.push({ param: "interval", message: "A custom price needs an interval (month or year)." });
    return missing;
  });
  const { organizationId, currency, now } = ctx;

  const customer = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId, externalId: input.customer_external_id } },
    select: { id: true },
  });
  if (customer === null) {
    throw notFound(
      `No customer with external_id ${input.customer_external_id}. PUT /v1/customers/${input.customer_external_id} first.`,
      "customer_external_id",
    );
  }

  const existing = await findChain(organizationId, externalId);
  if (existing === null) return createChain(ctx, externalId, input, customer.id);

  const first = existing[0];
  const current = existing[existing.length - 1];
  if (first === undefined || current === undefined) throw notFound(`No subscription with external_id ${externalId}.`);
  if (first.customerId !== customer.id) {
    throw conflict(
      `This subscription belongs to customer ${first.customer.externalId ?? first.customer.name}; a subscription can't move to another customer.`,
      "customer_external_id",
    );
  }
  if (first.startedAt.getTime() !== input.start_date.getTime()) {
    throw conflict(
      `This subscription started on ${formatDay(first.startedAt)}. A start date can't be changed through the API — correct it in Meridian, or delete and push it again.`,
      "start_date",
    );
  }

  const terms = await desiredTerms(ctx, input, current);
  const change = terms.planChanged || terms.quantityChanged;
  const effectiveDate = input.effective_date ?? dayToDate(todayUtc(now));
  const status = input.status ?? null;
  const wantedEnd = input.end_date ?? null;
  const currentEnd = current.canceledAt !== null ? current.endedAt : null;
  const scheduled = currentEnd !== null && currentEnd > now;
  const endDiffers = (wantedEnd?.getTime() ?? null) !== (currentEnd?.getTime() ?? null);
  const statusDiffers = status !== null && status !== current.status && (current.endedAt === null || current.endedAt > now);
  // A different (or no) end date starts by undoing the cancellation; changing
  // terms or status needs a scheduled one out of the way too — the UI's rule —
  // and it is put back afterwards. A cancellation already in effect can't be
  // undone, and the Undo operation's refusal says so.
  const undo = currentEnd !== null && (endDiffers || (scheduled && (change || statusDiffers)));

  // Refusals knowable up front, so nothing is half-applied.
  const termsStart = change ? effectiveDate : current.startedAt;
  if (wantedEnd !== null && (endDiffers || undo) && wantedEnd.getTime() <= termsStart.getTime()) {
    throw conflict(
      change
        ? `end_date must be after effective_date (${formatDay(effectiveDate)}), when the new terms begin.`
        : `Pick a date after ${formatDay(current.startedAt)}, when these terms began. To remove a subscription that never ran, delete it.`,
      "end_date",
    );
  }

  const changes: SubscriptionChange[] = [];
  let segmentId = current.id;
  if (undo) {
    applied(ctx, await undoScheduledCancelOp(organizationId, segmentId, now));
    changes.push("cancel_undone");
  }
  if (change) {
    const next = applied(
      ctx,
      await changeSubscriptionOp(
        organizationId,
        currency,
        {
          subscriptionId: segmentId,
          planId: terms.planId,
          price: terms.price,
          interval: terms.interval,
          intervalCount: terms.intervalCount,
          quantity: terms.quantity,
          effectiveDate,
        },
        now,
        { source: ctx.source, externalId: segmentExternalId(externalId, effectiveDate) },
      ),
      CHANGE_PARAMS,
    );
    segmentId = next.subscriptionId;
    if (terms.planChanged) changes.push("plan_changed");
    if (terms.quantityChanged) changes.push("quantity_changed");
  }
  if (statusDiffers && status !== null) {
    const latest = (await reload(ctx, externalId)).find((segment) => segment.id === segmentId);
    if (latest === undefined) throw notFound(`No subscription with external_id ${externalId}.`);
    if (latest.status !== status) {
      applied(
        ctx,
        await correctSubscriptionOp(
          organizationId,
          currency,
          { subscriptionId: segmentId, startDate: latest.startedAt, price: latest.amountCents, quantity: latest.quantity, status },
          now,
        ),
        { status: "status" },
      );
      changes.push("status_changed");
    }
  }
  if (wantedEnd !== null && (endDiffers || undo)) {
    applied(ctx, await cancelSubscriptionOp(organizationId, { subscriptionId: segmentId, effectiveDate: wantedEnd }, now), {
      effectiveDate: "end_date",
    });
    changes.push(wantedEnd.getTime() <= now.getTime() ? "canceled" : "cancel_scheduled");
  }
  if (changes.length === 0) changes.push("unchanged");

  const chain = await reload(ctx, externalId);
  return { created: false, record: { ...subscriptionWire(chain, currency, now), changes } };
}

async function createChain(
  ctx: ApiWriteContext,
  externalId: string,
  input: PutInput,
  customerId: string,
): Promise<SubscriptionPutResult> {
  const { organizationId, currency, now } = ctx;
  const planId = input.plan_external_id === undefined ? CUSTOM_PRICE : await planIdOf(ctx, input.plan_external_id);
  const created = applied(
    ctx,
    await createSubscriptionOp(
      organizationId,
      currency,
      {
        customerId,
        newCustomerName: "",
        planId,
        price: input.amount ?? null,
        interval: planId === CUSTOM_PRICE ? (input.interval ?? null) : null,
        intervalCount: planId === CUSTOM_PRICE ? (input.interval_count ?? 1) : null,
        quantity: input.quantity ?? 1,
        status: input.status ?? "ACTIVE",
        startDate: input.start_date,
        recordPastInvoices: false,
      },
      now,
      { source: ctx.source, externalId: segmentExternalId(externalId, input.start_date) },
    ),
    { customerId: "customer_external_id", planId: "plan_external_id", price: "amount", quantity: "quantity" },
  );
  const changes: SubscriptionChange[] = ["created"];
  if (input.end_date) {
    applied(
      ctx,
      await cancelSubscriptionOp(organizationId, { subscriptionId: created.subscriptionId, effectiveDate: input.end_date }, now),
      { effectiveDate: "end_date" },
    );
    changes.push(input.end_date.getTime() <= now.getTime() ? "canceled" : "cancel_scheduled");
  }
  const chain = await reload(ctx, externalId);
  return { created: true, record: { ...subscriptionWire(chain, currency, now), changes } };
}

export async function getSubscription(ctx: ApiWriteContext, externalId: string): Promise<SubscriptionWire> {
  return subscriptionWire(await reload(ctx, externalId), ctx.currency, ctx.now);
}

/** Deletes the whole chain and its invoices, as the UI's Delete does. */
export async function deleteSubscription(
  ctx: ApiWriteContext,
  externalId: string,
): Promise<{ object: "subscription"; external_id: string; deleted: true; segments: number; invoices: number }> {
  const chain = await reload(ctx, externalId);
  const head = chain[0];
  if (head === undefined) throw notFound(`No subscription with external_id ${externalId}.`);
  const result = applied(ctx, await deleteSubscriptionChainOp(ctx.organizationId, head.id));
  return { object: "subscription", external_id: externalId, deleted: true, ...result };
}

/**
 * Chains in order of their first segment's id. Filterable by customer. Chains
 * created in the UI have no external_id and are listed too.
 */
export async function listSubscriptions(
  ctx: ApiWriteContext,
  query: URLSearchParams,
): Promise<ListBody<SubscriptionWire>> {
  const page = pageParams(query);
  const customerExternalId = query.get("customer_external_id");
  let customerId: string | undefined;
  if (customerExternalId !== null) {
    const customer = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId: customerExternalId } },
      select: { id: true },
    });
    if (customer === null) throw notFound(`No customer with external_id ${customerExternalId}.`, "customer_external_id");
    customerId = customer.id;
  }
  const heads = await prisma.subscription.findMany({
    where: {
      organizationId: ctx.organizationId,
      previousSubscriptionId: null,
      ...(customerId === undefined ? {} : { customerId }),
      ...(page.startingAfter === null ? {} : { id: { gt: page.startingAfter } }),
    },
    orderBy: { id: "asc" },
    take: page.limit + 1,
    select: { id: true, customerId: true },
  });
  const segments = await prisma.subscription.findMany({
    where: { organizationId: ctx.organizationId, customerId: { in: [...new Set(heads.map((head) => head.customerId))] } },
    select: SEGMENT_SELECT,
  });
  const chainByHead = new Map<string, Segment[]>();
  for (const chain of chainsOf(segments)) {
    const head = chain[0];
    if (head !== undefined) chainByHead.set(head.id, chain);
  }
  const pageHeads = heads.slice(0, page.limit);
  const hasMore = heads.length > page.limit;
  return {
    object: "list",
    data: pageHeads.flatMap((head) => {
      const chain = chainByHead.get(head.id);
      return chain === undefined ? [] : [subscriptionWire(chain, ctx.currency, ctx.now)];
    }),
    has_more: hasMore,
    next_cursor: hasMore ? (pageHeads[pageHeads.length - 1]?.id ?? null) : null,
  };
}
