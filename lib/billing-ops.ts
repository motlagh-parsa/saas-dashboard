import "server-only";

// Billing writes — customers, plans, subscriptions, invoices — as plain server
// functions over already-validated input.
//
// The Server Actions (lib/customer-actions.ts, plan-actions.ts,
// subscription-actions.ts, invoice-actions.ts) authorize the caller, parse the
// form with lib/billing-form.ts, and then call exactly one of these. Keeping the
// writes here, free of session and request context, is what lets
// scripts/verify-metrics.ts drive the SAME code the UI does and assert the
// metrics after each step.
//
// Contract for every function:
//   - `organizationId` is trusted (the action checked membership). Every record
//     id is NOT: each is re-checked to belong to that organization inside the
//     query (`where: { id, organizationId }`), so an id from another workspace
//     matches nothing and is refused as stale.
//   - A refusal is a value (`{ ok: false }`), never a throw.
//   - A success says which day the metrics changed from (`affectedFrom`, null when
//     no snapshot can move) and carries the audit entry to record, with a
//     prepared one-line `detail` and structured before/after values.
//   - Every row written has `source = MANUAL`.
//
// The subscription SEGMENT model (see prisma/schema.prisma) is kept throughout:
// a change never edits a past segment in place — it ends the current segment on
// the effective date and opens the next one the same day, linked through
// `previousSubscriptionId`. Only Correct rewrites a segment, and says so.
import {
  Prisma,
  type BillingInterval,
  type DataSource,
  type InvoiceStatus,
  type SubscriptionStatus,
} from "@prisma/client";

import type { AuditAction, AuditTargetType } from "@/lib/audit-view";
import {
  CUSTOM_PRICE,
  LIVE_STATUSES,
  NEW_CUSTOMER,
  PLAN_NAME_TAKEN,
  dateToDay,
  dayToDate,
  todayUtc,
} from "@/lib/billing-form";
import {
  formatDay,
  formatEnumLabel,
  formatIntervalWords,
  formatMoneyExact,
  formatPrice,
} from "@/lib/format";
import { MAX_MINOR_UNITS } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { monthsInInterval } from "@/lib/snapshot-formula";
import { settleEndedSegments } from "@/lib/snapshots";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface AuditDraft {
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly metadata: Prisma.InputJsonObject;
}

export type OpResult<T = null> =
  | {
      readonly ok: true;
      readonly value: T;
      /** The first day whose stored snapshot may have changed; null if none can. */
      readonly affectedFrom: Date | null;
      readonly audit: AuditDraft;
      /** A short confirmation for the toast. */
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly message: string | null;
      readonly fieldErrors: Readonly<Record<string, string>>;
    };

const STALE = "This page is out of date. Reload it and try again.";
const CONFLICT = "Someone else changed this at the same moment. Reload and try again.";

function refuse(message: string): OpResult<never> {
  return { ok: false, message, fieldErrors: {} };
}

function fieldError(field: string, message: string): OpResult<never> {
  return { ok: false, message: null, fieldErrors: { [field]: message } };
}

/**
 * Where a created row comes from, and the caller's own ID for it. The UI passes
 * nothing (MANUAL, no external ID); the REST API passes source API and the
 * external_id from the URL, so the same operation serves both.
 */
export interface WriteOptions {
  readonly source?: DataSource;
  readonly externalId?: string | null;
}

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Calendar-month arithmetic that clamps the day (Jan 31 + 1 month => Feb 28/29). */
function addMonthsUTC(value: Date, months: number): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(value.getUTCDate(), lastDay)));
}

function earliest(...dates: readonly (Date | null | undefined)[]): Date | null {
  let min: Date | null = null;
  for (const date of dates) {
    if (date && (min === null || date.getTime() < min.getTime())) min = date;
  }
  return min;
}

/** "Pro · $49 × 2 / month" — how a segment's terms read in the log and the UI. */
export function describeTerms(
  terms: {
    readonly planName: string | null;
    readonly amountCents: number;
    readonly quantity: number;
    readonly interval: BillingInterval;
    readonly intervalCount: number;
  },
  currency: string,
): string {
  const seats = terms.quantity === 1 ? "" : ` × ${terms.quantity}`;
  return `${terms.planName ?? "Custom"} · ${formatPrice(terms.amountCents, currency)}${seats} / ${formatIntervalWords(terms.interval, terms.intervalCount)}`;
}

const SEGMENT_SELECT = {
  id: true,
  customerId: true,
  planId: true,
  status: true,
  amountCents: true,
  quantity: true,
  interval: true,
  intervalCount: true,
  startedAt: true,
  endedAt: true,
  canceledAt: true,
  previousSubscriptionId: true,
  next: { select: { id: true } },
  plan: { select: { name: true } },
  customer: { select: { name: true } },
} as const satisfies Prisma.SubscriptionSelect;

type SegmentRow = Prisma.SubscriptionGetPayload<{ select: typeof SEGMENT_SELECT }>;

/**
 * The CURRENT segment of a subscription — the last of its chain — scoped to the
 * workspace, and still running (or not started yet). Every lifecycle operation
 * starts here.
 */
async function currentSegment(
  organizationId: string,
  subscriptionId: string,
  now: Date,
): Promise<{ ok: true; segment: SegmentRow } | { ok: false; message: string }> {
  const segment = await prisma.subscription.findFirst({
    where: { id: subscriptionId, organizationId },
    select: SEGMENT_SELECT,
  });
  if (segment === null) return { ok: false, message: STALE };
  if (segment.next !== null) {
    return { ok: false, message: "These terms were already replaced by a later change. Reload to see the current ones." };
  }
  if (segment.endedAt !== null && segment.endedAt.getTime() <= now.getTime()) {
    return { ok: false, message: `This subscription ended on ${formatDay(segment.endedAt)}; there is nothing left to change.` };
  }
  return { ok: true, segment };
}

function planNameOf(segment: SegmentRow): string {
  return segment.plan?.name ?? "Custom";
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface CustomerInput {
  readonly name: string;
  readonly email: string | null;
}

export async function createCustomerOp(
  organizationId: string,
  input: CustomerInput,
  options: WriteOptions = {},
): Promise<OpResult<{ id: string }>> {
  const customer = await prisma.customer.create({
    data: {
      organizationId,
      name: input.name,
      email: input.email,
      source: options.source ?? "MANUAL",
      externalId: options.externalId ?? null,
    },
    select: { id: true },
  });
  return {
    ok: true,
    value: customer,
    affectedFrom: null,
    message: `${input.name} was added.`,
    audit: {
      action: "customer.created",
      targetType: "customer",
      targetId: customer.id,
      targetLabel: input.name,
      metadata: { customerId: customer.id, email: input.email, detail: input.email ?? "No email" },
    },
  };
}

export async function updateCustomerOp(
  organizationId: string,
  customerId: string,
  input: CustomerInput,
): Promise<OpResult> {
  const before = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { name: true, email: true },
  });
  if (before === null) return refuse(STALE);
  if (before.name === input.name && before.email === input.email) {
    return fieldError("name", "Nothing changed.");
  }
  await prisma.customer.updateMany({
    where: { id: customerId, organizationId },
    data: { name: input.name, email: input.email },
  });

  const parts: string[] = [];
  if (before.name !== input.name) parts.push(`${before.name} → ${input.name}`);
  if (before.email !== input.email) parts.push(`Email ${before.email ?? "none"} → ${input.email ?? "none"}`);
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: "Customer saved.",
    audit: {
      action: "customer.updated",
      targetType: "customer",
      targetId: customerId,
      targetLabel: input.name,
      metadata: {
        customerId,
        before: { name: before.name, email: before.email },
        after: { name: input.name, email: input.email },
        detail: parts.join(" · "),
      },
    },
  };
}

/**
 * Archive keeps the customer's whole history — every metric still counts it —
 * and only hides them from pickers and the default list. So no snapshot moves.
 */
export async function setCustomerArchivedOp(
  organizationId: string,
  customerId: string,
  archived: boolean,
): Promise<OpResult> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { name: true, archivedAt: true },
  });
  if (customer === null) return refuse(STALE);
  if ((customer.archivedAt !== null) === archived) {
    return refuse(archived ? `${customer.name} is already archived.` : `${customer.name} isn't archived.`);
  }
  await prisma.customer.updateMany({
    where: { id: customerId, organizationId },
    data: { archivedAt: archived ? new Date() : null },
  });
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: archived ? `${customer.name} was archived.` : `${customer.name} was unarchived.`,
    audit: {
      action: archived ? "customer.archived" : "customer.unarchived",
      targetType: "customer",
      targetId: customerId,
      targetLabel: customer.name,
      metadata: {
        customerId,
        detail: archived ? "Hidden from pickers; history and metrics kept" : "Back in pickers",
      },
    },
  };
}

/**
 * Deletes the customer and, by cascade, every subscription and invoice of
 * theirs. For mistakes only — the dialog makes the caller type the name, and
 * this re-checks it against the stored one.
 */
export async function deleteCustomerOp(
  organizationId: string,
  customerId: string,
  confirmName: string,
): Promise<OpResult<{ subscriptions: number; invoices: number }>> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
    select: {
      name: true,
      _count: { select: { subscriptions: true, invoices: true } },
      subscriptions: { select: { startedAt: true }, orderBy: { startedAt: "asc" }, take: 1 },
    },
  });
  if (customer === null) return refuse(STALE);
  if (confirmName.trim() !== customer.name) {
    return fieldError("confirmName", `Type ${customer.name} exactly to confirm.`);
  }

  await prisma.customer.deleteMany({ where: { id: customerId, organizationId } });
  const counts = {
    subscriptions: customer._count.subscriptions,
    invoices: customer._count.invoices,
  };
  return {
    ok: true,
    value: counts,
    affectedFrom: customer.subscriptions[0]?.startedAt ?? null,
    message: `${customer.name} was deleted.`,
    audit: {
      action: "customer.deleted",
      targetType: "customer",
      targetId: customerId,
      targetLabel: customer.name,
      metadata: {
        customerId,
        ...counts,
        detail: `With ${counts.subscriptions} subscription${counts.subscriptions === 1 ? "" : "s"} and ${counts.invoices} invoice${counts.invoices === 1 ? "" : "s"}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanInput {
  readonly name: string;
  readonly price: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
}

async function planNameTaken(organizationId: string, name: string, exceptId: string | null): Promise<boolean> {
  const clash = await prisma.plan.findFirst({
    where: {
      organizationId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId === null ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  return clash !== null;
}

function planTerms(input: PlanInput, currency: string): string {
  return `${formatPrice(input.price, currency)} / ${formatIntervalWords(input.interval, input.intervalCount)}`;
}

export async function createPlanOp(
  organizationId: string,
  currency: string,
  input: PlanInput,
  options: WriteOptions = {},
): Promise<OpResult<{ id: string }>> {
  if (await planNameTaken(organizationId, input.name, null)) return fieldError("name", PLAN_NAME_TAKEN);
  let plan: { id: string };
  try {
    plan = await prisma.plan.create({
      data: {
        organizationId,
        name: input.name,
        amountCents: input.price,
        interval: input.interval,
        intervalCount: input.intervalCount,
        source: options.source ?? "MANUAL",
        externalId: options.externalId ?? null,
      },
      select: { id: true },
    });
  } catch (error: unknown) {
    // The unique index is the real guard against two creates racing.
    if (isKnownError(error, "P2002")) return fieldError("name", PLAN_NAME_TAKEN);
    throw error;
  }
  return {
    ok: true,
    value: plan,
    affectedFrom: null,
    message: `${input.name} was created.`,
    audit: {
      action: "plan.created",
      targetType: "plan",
      targetId: plan.id,
      targetLabel: input.name,
      metadata: { detail: planTerms(input, currency) },
    },
  };
}

/**
 * A subscription COPIES its plan's price when it starts, so repricing a plan
 * changes new subscriptions only — nothing already running, and no snapshot.
 */
export async function updatePlanOp(
  organizationId: string,
  currency: string,
  planId: string,
  input: PlanInput,
): Promise<OpResult> {
  const before = await prisma.plan.findFirst({
    where: { id: planId, organizationId },
    select: { name: true, amountCents: true, interval: true, intervalCount: true },
  });
  if (before === null) return refuse(STALE);
  const previous: PlanInput = {
    name: before.name,
    price: before.amountCents,
    interval: before.interval,
    intervalCount: before.intervalCount,
  };
  if (
    previous.name === input.name &&
    previous.price === input.price &&
    previous.interval === input.interval &&
    previous.intervalCount === input.intervalCount
  ) {
    return fieldError("name", "Nothing changed.");
  }
  if (await planNameTaken(organizationId, input.name, planId)) return fieldError("name", PLAN_NAME_TAKEN);

  try {
    await prisma.plan.updateMany({
      where: { id: planId, organizationId },
      data: {
        name: input.name,
        amountCents: input.price,
        interval: input.interval,
        intervalCount: input.intervalCount,
      },
    });
  } catch (error: unknown) {
    if (isKnownError(error, "P2002")) return fieldError("name", PLAN_NAME_TAKEN);
    throw error;
  }

  const parts: string[] = [];
  if (previous.name !== input.name) parts.push(`${previous.name} → ${input.name}`);
  const oldTerms = planTerms(previous, currency);
  const newTerms = planTerms(input, currency);
  if (oldTerms !== newTerms) parts.push(`${oldTerms} → ${newTerms}`);
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: `${input.name} was saved.`,
    audit: {
      action: "plan.updated",
      targetType: "plan",
      targetId: planId,
      targetLabel: input.name,
      metadata: {
        before: { ...previous },
        after: { ...input },
        detail: parts.join(" · "),
      },
    },
  };
}

/** Archive hides the plan from pickers; subscriptions already on it are untouched. */
export async function setPlanArchivedOp(
  organizationId: string,
  planId: string,
  archived: boolean,
): Promise<OpResult> {
  const plan = await prisma.plan.findFirst({
    where: { id: planId, organizationId },
    select: { name: true, archivedAt: true },
  });
  if (plan === null) return refuse(STALE);
  if ((plan.archivedAt !== null) === archived) {
    return refuse(archived ? `${plan.name} is already archived.` : `${plan.name} isn't archived.`);
  }
  await prisma.plan.updateMany({
    where: { id: planId, organizationId },
    data: { archivedAt: archived ? new Date() : null },
  });
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: archived ? `${plan.name} was archived.` : `${plan.name} was unarchived.`,
    audit: {
      action: archived ? "plan.archived" : "plan.unarchived",
      targetType: "plan",
      targetId: planId,
      targetLabel: plan.name,
      metadata: {
        detail: archived ? "No longer offered; existing subscriptions unaffected" : "Offered again",
      },
    },
  };
}

/** Only a plan no subscription has ever used can be deleted; anything else is archived. */
export async function deletePlanOp(organizationId: string, planId: string): Promise<OpResult> {
  const plan = await prisma.plan.findFirst({
    where: { id: planId, organizationId },
    select: { name: true, _count: { select: { subscriptions: true } } },
  });
  if (plan === null) return refuse(STALE);
  const used = plan._count.subscriptions;
  if (used > 0) {
    return refuse(
      `${plan.name} is used by ${used} subscription${used === 1 ? "" : "s"}, so it can't be deleted. Archive it instead.`,
    );
  }
  // Conditional on still being unused: a subscription created in between wins.
  const { count } = await prisma.plan.deleteMany({
    where: { id: planId, organizationId, subscriptions: { none: {} } },
  });
  if (count === 0) return refuse(CONFLICT);
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: `${plan.name} was deleted.`,
    audit: {
      action: "plan.deleted",
      targetType: "plan",
      targetId: planId,
      targetLabel: plan.name,
      metadata: { detail: "Never used by a subscription" },
    },
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  /** An existing customer's id, or NEW_CUSTOMER with `newCustomerName`. */
  readonly customerId: string;
  readonly newCustomerName: string;
  /** A plan id, or CUSTOM_PRICE. */
  readonly planId: string;
  /** Null means "the plan's price" (never null for a custom price). */
  readonly price: number | null;
  readonly interval: BillingInterval | null;
  readonly intervalCount: number | null;
  readonly quantity: number;
  readonly status: (typeof LIVE_STATUSES)[number];
  readonly startDate: Date;
  readonly recordPastInvoices: boolean;
}

interface ResolvedTerms {
  readonly planId: string | null;
  readonly planName: string | null;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
}

/**
 * The price terms a new segment copies: the plan's (with an optional price
 * override — a discount is real) or a custom price. The plan must belong to the
 * workspace and not be archived — except the plan the subscription is ALREADY
 * on (`keepPlanId`): adding a seat to a customer on a retired plan keeps them
 * on it rather than forcing a plan change.
 */
async function resolveTerms(
  organizationId: string,
  input: {
    readonly planId: string;
    readonly price: number | null;
    readonly interval: BillingInterval | null;
    readonly intervalCount: number | null;
  },
  keepPlanId: string | null = null,
): Promise<{ ok: true; terms: ResolvedTerms } | { ok: false; result: OpResult<never> }> {
  if (input.planId === CUSTOM_PRICE) {
    if (input.price === null || input.interval === null || input.intervalCount === null) {
      return { ok: false, result: fieldError("price", "Enter the custom price and how often it bills.") };
    }
    return {
      ok: true,
      terms: {
        planId: null,
        planName: null,
        amountCents: input.price,
        interval: input.interval,
        intervalCount: input.intervalCount,
      },
    };
  }
  const plan = await prisma.plan.findFirst({
    where: {
      id: input.planId,
      organizationId,
      ...(input.planId === keepPlanId ? {} : { archivedAt: null }),
    },
    select: { id: true, name: true, amountCents: true, interval: true, intervalCount: true },
  });
  if (plan === null) {
    return { ok: false, result: fieldError("planId", "That plan is no longer offered. Reload and pick again.") };
  }
  return {
    ok: true,
    terms: {
      planId: plan.id,
      planName: plan.name,
      amountCents: input.price ?? plan.amountCents,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
    },
  };
}

/** Invoices for "Also record past invoices": one per billing period started by today. */
const MAX_BACKFILL_INVOICES = 600;

function elapsedPeriodStarts(start: Date, interval: BillingInterval, intervalCount: number, today: Date): Date[] {
  const months = monthsInInterval(interval, intervalCount);
  const starts: Date[] = [];
  for (let k = 0; k < MAX_BACKFILL_INVOICES; k += 1) {
    // From the original start each time, so a Jan 31 start bills Feb 28, then Mar 31.
    const at = addMonthsUTC(start, k * months);
    if (at.getTime() > today.getTime()) break;
    starts.push(at);
  }
  return starts;
}

export async function createSubscriptionOp(
  organizationId: string,
  currency: string,
  input: CreateSubscriptionInput,
  now: Date = new Date(),
  options: WriteOptions = {},
): Promise<OpResult<{ subscriptionId: string; customerId: string; invoices: number }>> {
  const source = options.source ?? "MANUAL";
  const existingCustomer =
    input.customerId === NEW_CUSTOMER
      ? null
      : await prisma.customer.findFirst({
          where: { id: input.customerId, organizationId, archivedAt: null },
          select: { id: true, name: true },
        });
  if (input.customerId !== NEW_CUSTOMER && existingCustomer === null) {
    return fieldError("customerId", "That customer is archived or no longer in this workspace. Reload and pick again.");
  }

  const resolved = await resolveTerms(organizationId, input);
  if (!resolved.ok) return resolved.result;
  const terms = resolved.terms;

  const billed = terms.amountCents * input.quantity;
  if (billed > MAX_MINOR_UNITS) {
    return fieldError("quantity", "Price × quantity is larger than a single invoice can hold.");
  }

  const today = dayToDate(todayUtc(now));
  const invoiceDates =
    input.recordPastInvoices && billed > 0
      ? elapsedPeriodStarts(input.startDate, terms.interval, terms.intervalCount, today)
      : [];

  const created = await prisma.$transaction(async (tx) => {
    const customer =
      existingCustomer ??
      (await tx.customer.create({
        data: { organizationId, name: input.newCustomerName, source },
        select: { id: true, name: true },
      }));
    const subscription = await tx.subscription.create({
      data: {
        organizationId,
        customerId: customer.id,
        planId: terms.planId,
        status: input.status,
        amountCents: terms.amountCents,
        quantity: input.quantity,
        interval: terms.interval,
        intervalCount: terms.intervalCount,
        startedAt: input.startDate,
        source,
        externalId: options.externalId ?? null,
      },
      select: { id: true },
    });
    if (invoiceDates.length > 0) {
      await tx.invoice.createMany({
        data: invoiceDates.map((issuedAt) => ({
          organizationId,
          customerId: customer.id,
          subscriptionId: subscription.id,
          amountCents: billed,
          status: "PAID" as const,
          issuedAt,
          dueAt: issuedAt,
          paidAt: issuedAt,
          source,
        })),
      });
    }
    return { subscriptionId: subscription.id, customer };
  });

  const described = describeTerms({ ...terms, quantity: input.quantity }, currency);
  const invoiceNote =
    invoiceDates.length > 0
      ? ` · ${invoiceDates.length} past invoice${invoiceDates.length === 1 ? "" : "s"} recorded`
      : "";
  return {
    ok: true,
    value: {
      subscriptionId: created.subscriptionId,
      customerId: created.customer.id,
      invoices: invoiceDates.length,
    },
    affectedFrom: input.startDate,
    message: `${created.customer.name} · ${described}`,
    audit: {
      action: "subscription.created",
      targetType: "subscription",
      targetId: created.subscriptionId,
      targetLabel: `${created.customer.name} · ${terms.planName ?? "Custom"}`,
      metadata: {
        customerId: created.customer.id,
        customer: created.customer.name,
        plan: terms.planName ?? "Custom",
        amountCents: terms.amountCents,
        quantity: input.quantity,
        interval: terms.interval,
        intervalCount: terms.intervalCount,
        currency,
        startedAt: dateToDay(input.startDate),
        status: input.status,
        newCustomer: existingCustomer === null,
        pastInvoices: invoiceDates.length,
        detail: `${described} from ${formatDay(input.startDate)}${invoiceNote}`,
      },
    },
  };
}

export interface ChangeSubscriptionInput {
  readonly subscriptionId: string;
  readonly planId: string;
  readonly price: number | null;
  readonly interval: BillingInterval | null;
  readonly intervalCount: number | null;
  readonly quantity: number;
  readonly effectiveDate: Date;
}

/**
 * Change plan or quantity from `effectiveDate`: the current segment ends that
 * day and a new one opens the same day, linked to it. The date may be in the
 * past — history entered late — but not on or before the current terms' start
 * (that is a correction, not a change) and not more than a year ahead.
 */
export async function changeSubscriptionOp(
  organizationId: string,
  currency: string,
  input: ChangeSubscriptionInput,
  now: Date = new Date(),
  options: WriteOptions = {},
): Promise<OpResult<{ subscriptionId: string }>> {
  await settleEndedSegments(prisma, organizationId, now);
  const found = await currentSegment(organizationId, input.subscriptionId, now);
  if (!found.ok) return refuse(found.message);
  const current = found.segment;

  if (current.canceledAt !== null) {
    return refuse(
      `A cancellation is scheduled for ${formatDay(current.endedAt ?? current.canceledAt)}. Undo it before changing the plan.`,
    );
  }
  if (input.effectiveDate.getTime() <= current.startedAt.getTime()) {
    return fieldError(
      "effectiveDate",
      `Pick a date after ${formatDay(current.startedAt)}, when the current terms began. To fix the start itself, use Correct.`,
    );
  }

  const resolved = await resolveTerms(organizationId, input, current.planId);
  if (!resolved.ok) return resolved.result;
  const terms = resolved.terms;
  if (terms.amountCents * input.quantity > MAX_MINOR_UNITS) {
    return fieldError("quantity", "Price × quantity is larger than a single invoice can hold.");
  }
  if (
    terms.planId === current.planId &&
    terms.amountCents === current.amountCents &&
    terms.interval === current.interval &&
    terms.intervalCount === current.intervalCount &&
    input.quantity === current.quantity
  ) {
    return fieldError("planId", "Nothing would change — pick a different plan, price or quantity.");
  }

  const endsNow = input.effectiveDate.getTime() <= now.getTime();
  const carriedStatus: SubscriptionStatus = current.status === "CANCELED" ? "ACTIVE" : current.status;

  let nextId: string;
  try {
    nextId = await prisma.$transaction(async (tx) => {
      // Conditional on the segment still being open, so two changes racing on
      // the same terms cannot both end it; the loser is told to reload.
      const { count } = await tx.subscription.updateMany({
        where: { id: current.id, organizationId, endedAt: null, canceledAt: null },
        data: { endedAt: input.effectiveDate, ...(endsNow ? { status: "CANCELED" as const } : {}) },
      });
      if (count === 0) throw new ConflictError();
      const next = await tx.subscription.create({
        data: {
          organizationId,
          customerId: current.customerId,
          planId: terms.planId,
          status: carriedStatus,
          amountCents: terms.amountCents,
          quantity: input.quantity,
          interval: terms.interval,
          intervalCount: terms.intervalCount,
          startedAt: input.effectiveDate,
          previousSubscriptionId: current.id,
          source: options.source ?? "MANUAL",
          externalId: options.externalId ?? null,
        },
        select: { id: true },
      });
      return next.id;
    });
  } catch (error: unknown) {
    // P2002: `previousSubscriptionId` is unique — a racing change already linked a successor.
    if (error instanceof ConflictError || isKnownError(error, "P2002")) return refuse(CONFLICT);
    throw error;
  }

  const before = describeTerms(
    { planName: current.plan?.name ?? null, ...pickTerms(current) },
    currency,
  );
  const after = describeTerms({ ...terms, quantity: input.quantity }, currency);
  const planChanged = terms.planId !== current.planId || terms.amountCents !== current.amountCents;
  const summary = planChanged
    ? `${planNameOf(current)} → ${terms.planName ?? "Custom"}`
    : `Quantity ${current.quantity} → ${input.quantity}`;
  return {
    ok: true,
    value: { subscriptionId: nextId },
    affectedFrom: input.effectiveDate,
    message: `${summary} from ${formatDay(input.effectiveDate)}`,
    audit: {
      action: "subscription.changed",
      targetType: "subscription",
      targetId: nextId,
      targetLabel: `${current.customer.name} · ${terms.planName ?? "Custom"}`,
      metadata: {
        customerId: current.customerId,
        previousSubscriptionId: current.id,
        effectiveDate: dateToDay(input.effectiveDate),
        before: { ...pickTerms(current), plan: planNameOf(current) },
        after: {
          amountCents: terms.amountCents,
          quantity: input.quantity,
          interval: terms.interval,
          intervalCount: terms.intervalCount,
          plan: terms.planName ?? "Custom",
        },
        detail: `${before} → ${after} from ${formatDay(input.effectiveDate)}`,
      },
    },
  };
}

class ConflictError extends Error {}

function pickTerms(segment: SegmentRow) {
  return {
    amountCents: segment.amountCents,
    quantity: segment.quantity,
    interval: segment.interval,
    intervalCount: segment.intervalCount,
  };
}

/**
 * Cancel on `effectiveDate`. Today or earlier: the subscription ended that day
 * (`endedAt = canceledAt = date`, CANCELED). Later: it is scheduled —
 * `canceledAt` is now, `endedAt` is the date, and the status stands until then.
 */
export async function cancelSubscriptionOp(
  organizationId: string,
  input: { readonly subscriptionId: string; readonly effectiveDate: Date },
  now: Date = new Date(),
): Promise<OpResult> {
  await settleEndedSegments(prisma, organizationId, now);
  const found = await currentSegment(organizationId, input.subscriptionId, now);
  if (!found.ok) return refuse(found.message);
  const current = found.segment;

  if (current.canceledAt !== null) {
    return refuse(`It is already set to end on ${formatDay(current.endedAt ?? current.canceledAt)}.`);
  }
  if (input.effectiveDate.getTime() <= current.startedAt.getTime()) {
    return fieldError(
      "effectiveDate",
      `Pick a date after ${formatDay(current.startedAt)}, when these terms began. To remove a subscription that never ran, delete it.`,
    );
  }

  const immediate = input.effectiveDate.getTime() <= now.getTime();
  const { count } = await prisma.subscription.updateMany({
    where: { id: current.id, organizationId, endedAt: null, canceledAt: null, next: { is: null } },
    data: immediate
      ? { endedAt: input.effectiveDate, canceledAt: input.effectiveDate, status: "CANCELED" }
      : { endedAt: input.effectiveDate, canceledAt: now },
  });
  if (count === 0) return refuse(CONFLICT);

  const when = formatDay(input.effectiveDate);
  return {
    ok: true,
    value: null,
    affectedFrom: input.effectiveDate,
    message: immediate ? `Canceled as of ${when}.` : `Scheduled to cancel on ${when}.`,
    audit: {
      action: "subscription.canceled",
      targetType: "subscription",
      targetId: current.id,
      targetLabel: `${current.customer.name} · ${planNameOf(current)}`,
      metadata: {
        customerId: current.customerId,
        effectiveDate: dateToDay(input.effectiveDate),
        scheduled: !immediate,
        detail: immediate ? `Ended ${when}` : `Scheduled to end ${when}`,
      },
    },
  };
}

/** Clears a cancellation that has not happened yet. */
export async function undoScheduledCancelOp(
  organizationId: string,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<OpResult> {
  const found = await currentSegment(organizationId, subscriptionId, now);
  if (!found.ok) return refuse(found.message);
  const current = found.segment;
  if (current.canceledAt === null || current.endedAt === null) {
    return refuse("There is no scheduled cancellation to undo.");
  }
  const endedAt = current.endedAt;
  const { count } = await prisma.subscription.updateMany({
    where: { id: current.id, organizationId, canceledAt: { not: null }, endedAt: { gt: now } },
    data: { canceledAt: null, endedAt: null },
  });
  if (count === 0) return refuse(CONFLICT);
  return {
    ok: true,
    value: null,
    affectedFrom: endedAt,
    message: "The scheduled cancellation was removed.",
    audit: {
      action: "subscription.cancel_undone",
      targetType: "subscription",
      targetId: current.id,
      targetLabel: `${current.customer.name} · ${planNameOf(current)}`,
      metadata: {
        customerId: current.customerId,
        detail: `Was going to end ${formatDay(endedAt)}`,
      },
    },
  };
}

export interface CorrectSubscriptionInput {
  readonly subscriptionId: string;
  readonly startDate: Date;
  readonly price: number;
  readonly quantity: number;
  readonly status: (typeof LIVE_STATUSES)[number];
}

/**
 * Correct: rewrites the CURRENT segment's start, price, quantity or status in
 * place — for data-entry mistakes, so it rewrites history on purpose and the log
 * keeps the before and after.
 *
 * When the segment continues an earlier one (a plan change), that one ended on
 * this start; moving the start moves that end with it, so the chain has no gap
 * and no overlap. The new start must stay after the earlier segment's own start.
 */
export async function correctSubscriptionOp(
  organizationId: string,
  currency: string,
  input: CorrectSubscriptionInput,
  now: Date = new Date(),
): Promise<OpResult> {
  const found = await currentSegment(organizationId, input.subscriptionId, now);
  if (!found.ok) return refuse(found.message);
  const current = found.segment;

  if (current.endedAt !== null && input.startDate.getTime() >= current.endedAt.getTime()) {
    return fieldError("startDate", `It must start before it ends on ${formatDay(current.endedAt)}.`);
  }
  if (input.price * input.quantity > MAX_MINOR_UNITS) {
    return fieldError("quantity", "Price × quantity is larger than a single invoice can hold.");
  }

  const previous =
    current.previousSubscriptionId === null
      ? null
      : await prisma.subscription.findFirst({
          where: { id: current.previousSubscriptionId, organizationId },
          select: { id: true, startedAt: true, endedAt: true },
        });
  const handOff =
    previous !== null &&
    previous.endedAt !== null &&
    previous.endedAt.getTime() === current.startedAt.getTime();
  if (handOff && input.startDate.getTime() <= previous.startedAt.getTime()) {
    return fieldError(
      "startDate",
      `The previous terms began on ${formatDay(previous.startedAt)}; these must start after that.`,
    );
  }

  const unchanged =
    input.startDate.getTime() === current.startedAt.getTime() &&
    input.price === current.amountCents &&
    input.quantity === current.quantity &&
    input.status === current.status;
  if (unchanged) return fieldError("startDate", "Nothing changed.");

  await prisma.$transaction(async (tx) => {
    if (handOff && previous !== null) {
      const previousEnded = input.startDate.getTime() <= now.getTime();
      await tx.subscription.updateMany({
        where: { id: previous.id, organizationId },
        data: {
          endedAt: input.startDate,
          // A hand-off moved into the future makes the earlier terms live again.
          status: previousEnded ? "CANCELED" : input.status,
        },
      });
    }
    await tx.subscription.updateMany({
      where: { id: current.id, organizationId },
      data: {
        startedAt: input.startDate,
        amountCents: input.price,
        quantity: input.quantity,
        status: input.status,
      },
    });
  });

  const changes: string[] = [];
  if (input.startDate.getTime() !== current.startedAt.getTime()) {
    changes.push(`Start ${formatDay(current.startedAt)} → ${formatDay(input.startDate)}`);
  }
  if (input.price !== current.amountCents) {
    changes.push(`Price ${formatMoneyExact(current.amountCents, currency)} → ${formatMoneyExact(input.price, currency)}`);
  }
  if (input.quantity !== current.quantity) changes.push(`Quantity ${current.quantity} → ${input.quantity}`);
  if (input.status !== current.status) {
    changes.push(`Status ${formatEnumLabel(current.status)} → ${formatEnumLabel(input.status)}`);
  }

  return {
    ok: true,
    value: null,
    affectedFrom: earliest(current.startedAt, input.startDate),
    message: "Subscription corrected.",
    audit: {
      action: "subscription.corrected",
      targetType: "subscription",
      targetId: current.id,
      targetLabel: `${current.customer.name} · ${planNameOf(current)}`,
      metadata: {
        customerId: current.customerId,
        before: {
          startedAt: dateToDay(current.startedAt),
          amountCents: current.amountCents,
          quantity: current.quantity,
          status: current.status,
        },
        after: {
          startedAt: dateToDay(input.startDate),
          amountCents: input.price,
          quantity: input.quantity,
          status: input.status,
        },
        movedPreviousEnd: handOff,
        detail: changes.join(" · "),
      },
    },
  };
}

/**
 * Deletes one subscription CHAIN — every segment linked to this one by plan
 * changes, before and after — and, by cascade, their invoices. For mistakes.
 */
export async function deleteSubscriptionChainOp(
  organizationId: string,
  subscriptionId: string,
): Promise<OpResult<{ segments: number; invoices: number }>> {
  const target = await prisma.subscription.findFirst({
    where: { id: subscriptionId, organizationId },
    select: { customerId: true, customer: { select: { name: true } } },
  });
  if (target === null) return refuse(STALE);

  const siblings = await prisma.subscription.findMany({
    where: { organizationId, customerId: target.customerId },
    select: { id: true, previousSubscriptionId: true, startedAt: true, plan: { select: { name: true } } },
  });
  const chain = subscriptionChain(siblings, subscriptionId);
  const ids = chain.map((segment) => segment.id);
  const invoices = await prisma.invoice.count({ where: { organizationId, subscriptionId: { in: ids } } });

  await prisma.subscription.deleteMany({ where: { organizationId, id: { in: ids } } });

  const first = chain[0];
  const last = chain[chain.length - 1];
  return {
    ok: true,
    value: { segments: ids.length, invoices },
    affectedFrom: earliest(...chain.map((segment) => segment.startedAt)),
    message: "Subscription deleted.",
    audit: {
      action: "subscription.deleted",
      targetType: "subscription",
      targetId: subscriptionId,
      targetLabel: `${target.customer.name} · ${last?.plan?.name ?? "Custom"}`,
      metadata: {
        customerId: target.customerId,
        segments: ids.length,
        invoices,
        detail: `${ids.length} segment${ids.length === 1 ? "" : "s"} from ${first ? formatDay(first.startedAt) : "?"}, ${invoices} invoice${invoices === 1 ? "" : "s"}`,
      },
    },
  };
}

/**
 * The segments linked to `id` through `previousSubscriptionId`, oldest first.
 * Pure, so the customer page groups its timeline with the same rule the delete
 * uses.
 */
export function subscriptionChain<S extends { readonly id: string; readonly previousSubscriptionId: string | null }>(
  segments: readonly S[],
  id: string,
): S[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const nextOf = new Map<string, S>();
  for (const segment of segments) {
    if (segment.previousSubscriptionId !== null) nextOf.set(segment.previousSubscriptionId, segment);
  }
  let head = byId.get(id);
  if (head === undefined) return [];
  const seen = new Set<string>([head.id]);
  while (head.previousSubscriptionId !== null) {
    const previous = byId.get(head.previousSubscriptionId);
    if (previous === undefined || seen.has(previous.id)) break;
    seen.add(previous.id);
    head = previous;
  }
  const chain: S[] = [head];
  let cursor = nextOf.get(head.id);
  while (cursor !== undefined && !chain.includes(cursor)) {
    chain.push(cursor);
    cursor = nextOf.get(cursor.id);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface RecordInvoiceInput {
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly amount: number;
  readonly issuedDate: Date;
  readonly dueDate: Date | null;
  readonly status: "DRAFT" | "OPEN" | "PAID";
  readonly paidDate: Date | null;
}

function invoiceLabel(customerName: string, invoiceId: string): string {
  return `${customerName} · #${invoiceId.slice(-8)}`;
}

/**
 * Invoices are money received or owed; no MetricSnapshot column is derived from
 * them, so none of these writes moves a snapshot (`affectedFrom` is null).
 */
export async function recordInvoiceOp(
  organizationId: string,
  currency: string,
  input: RecordInvoiceInput,
  options: WriteOptions = {},
): Promise<OpResult<{ id: string }>> {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, organizationId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (customer === null) {
    return fieldError("customerId", "That customer is archived or no longer in this workspace. Reload and pick again.");
  }
  if (input.subscriptionId !== null) {
    const subscription = await prisma.subscription.findFirst({
      where: { id: input.subscriptionId, organizationId, customerId: customer.id },
      select: { id: true },
    });
    if (subscription === null) {
      return fieldError("subscriptionId", "That subscription isn't this customer's. Pick again.");
    }
  }

  const invoice = await prisma.invoice.create({
    data: {
      organizationId,
      customerId: customer.id,
      subscriptionId: input.subscriptionId,
      amountCents: input.amount,
      status: input.status,
      issuedAt: input.issuedDate,
      dueAt: input.dueDate,
      paidAt: input.status === "PAID" ? input.paidDate : null,
      source: options.source ?? "MANUAL",
      externalId: options.externalId ?? null,
    },
    select: { id: true },
  });
  const amount = formatMoneyExact(input.amount, currency);
  return {
    ok: true,
    value: invoice,
    affectedFrom: null,
    message: `${amount} for ${customer.name} recorded.`,
    audit: {
      action: "invoice.created",
      targetType: "invoice",
      targetId: invoice.id,
      targetLabel: invoiceLabel(customer.name, invoice.id),
      metadata: {
        customerId: customer.id,
        amountCents: input.amount,
        status: input.status,
        issuedAt: dateToDay(input.issuedDate),
        detail: `${amount} · ${formatEnumLabel(input.status)} · issued ${formatDay(input.issuedDate)}`,
      },
    },
  };
}

type InvoiceTransition = "paid" | "void" | "uncollectible";

/** Which statuses each row action may move an invoice FROM. */
const TRANSITIONS: Record<InvoiceTransition, { from: readonly InvoiceStatus[]; to: InvoiceStatus; action: AuditAction }> = {
  // Recovered money counts too: an uncollectible invoice can still be paid.
  paid: { from: ["DRAFT", "OPEN", "UNCOLLECTIBLE"], to: "PAID", action: "invoice.paid" },
  // A paid invoice is not voided — that would be a refund, which is not modelled.
  void: { from: ["DRAFT", "OPEN"], to: "VOID", action: "invoice.voided" },
  uncollectible: { from: ["OPEN"], to: "UNCOLLECTIBLE", action: "invoice.uncollectible" },
};

export async function transitionInvoiceOp(
  organizationId: string,
  currency: string,
  invoiceId: string,
  transition: InvoiceTransition,
  paidDate: Date | null = null,
): Promise<OpResult> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { status: true, issuedAt: true, amountCents: true, customerId: true, customer: { select: { name: true } } },
  });
  if (invoice === null) return refuse(STALE);
  const rule = TRANSITIONS[transition];
  if (!rule.from.includes(invoice.status)) {
    return refuse(
      `A ${formatEnumLabel(invoice.status).toLowerCase()} invoice can't be marked ${formatEnumLabel(rule.to).toLowerCase()}.`,
    );
  }
  if (transition === "paid") {
    if (paidDate === null) return fieldError("paidDate", "Enter the date it was paid.");
    if (paidDate.getTime() < dayToDate(dateToDay(invoice.issuedAt)).getTime()) {
      return fieldError("paidDate", `It was issued on ${formatDay(invoice.issuedAt)}; it can't be paid before that.`);
    }
  }

  // Filtered on the status it was read in, so a racing action is refused, not overwritten.
  const { count } = await prisma.invoice.updateMany({
    where: { id: invoiceId, organizationId, status: invoice.status },
    data: { status: rule.to, paidAt: transition === "paid" ? paidDate : null },
  });
  if (count === 0) return refuse(CONFLICT);

  const amount = formatMoneyExact(invoice.amountCents, currency);
  const detail =
    transition === "paid" && paidDate !== null
      ? `${amount} paid ${formatDay(paidDate)}`
      : `${amount} · ${formatEnumLabel(invoice.status)} → ${formatEnumLabel(rule.to)}`;
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: detail,
    audit: {
      action: rule.action,
      targetType: "invoice",
      targetId: invoiceId,
      targetLabel: invoiceLabel(invoice.customer.name, invoiceId),
      metadata: { customerId: invoice.customerId, from: invoice.status, to: rule.to, detail },
    },
  };
}

/** Only a DRAFT or VOID invoice can be deleted: anything else is a financial record. */
export async function deleteInvoiceOp(
  organizationId: string,
  currency: string,
  invoiceId: string,
): Promise<OpResult> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { status: true, amountCents: true, customerId: true, customer: { select: { name: true } } },
  });
  if (invoice === null) return refuse(STALE);
  if (invoice.status !== "DRAFT" && invoice.status !== "VOID") {
    return refuse(
      `Only draft or void invoices can be deleted. This one is ${formatEnumLabel(invoice.status).toLowerCase()} — void it first if it was a mistake.`,
    );
  }
  const { count } = await prisma.invoice.deleteMany({
    where: { id: invoiceId, organizationId, status: { in: ["DRAFT", "VOID"] } },
  });
  if (count === 0) return refuse(CONFLICT);
  const detail = `${formatMoneyExact(invoice.amountCents, currency)} · ${formatEnumLabel(invoice.status)}`;
  return {
    ok: true,
    value: null,
    affectedFrom: null,
    message: "Invoice deleted.",
    audit: {
      action: "invoice.deleted",
      targetType: "invoice",
      targetId: invoiceId,
      targetLabel: invoiceLabel(invoice.customer.name, invoiceId),
      metadata: { customerId: invoice.customerId, detail },
    },
  };
}
