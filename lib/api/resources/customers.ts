import "server-only";

// /v1/customers — upsert by the caller's ID, list, read, archive. Every write
// is one of lib/billing-ops.ts's customer operations, the ones the UI uses.
import { z } from "zod";

import { createCustomerOp, setCustomerArchivedOp, updateCustomerOp } from "@/lib/billing-ops";
import type { CustomerFilter } from "@/lib/customer-list";
import { getCustomerRowsById, type CustomerPageRow } from "@/lib/customer-query";
import { prisma } from "@/lib/prisma";

import { applied, type ApiWriteContext } from "../context";
import { invalid, notFound, validationError } from "../errors";
import { customerNameSchema, emailSchema, listBody, pageParams, wireDay, wireEnum, type ListBody } from "../schema";
import { SEGMENT_SELECT, chainsOf, subscriptionWire, type SubscriptionWire } from "./chains";

const putSchema = z.strictObject({
  name: customerNameSchema,
  /** Omitted: unchanged. null: cleared. */
  email: emailSchema.nullable().optional(),
});

export interface CustomerWire {
  readonly object: "customer";
  readonly id: string;
  readonly external_id: string | null;
  readonly name: string;
  readonly email: string | null;
  /** active · past_due · churned · none (never paid) — as the Customers page shows it. */
  readonly status: CustomerPageRow["status"];
  readonly archived: boolean;
  readonly mrr: number;
  readonly currency: string;
  readonly customer_since: string | null;
  readonly source: string;
}

export interface CustomerDetailWire extends CustomerWire {
  readonly subscriptions: readonly SubscriptionWire[];
}

function customerWire(row: CustomerPageRow, currency: string): CustomerWire {
  return {
    object: "customer",
    id: row.id,
    external_id: row.externalId,
    name: row.name,
    email: row.email,
    status: row.status,
    archived: row.archived,
    mrr: row.mrrCents,
    currency,
    customer_since: row.customerSince === null ? null : wireDay(row.customerSince),
    source: wireEnum(row.source),
  };
}

export async function getCustomer(ctx: ApiWriteContext, externalId: string): Promise<CustomerDetailWire> {
  const [row] = await getCustomerRowsById(
    ctx.organizationId,
    { filter: "any", externalId, startingAfter: null, limit: 1 },
    ctx.now,
  );
  if (row === undefined) throw notFound(`No customer with external_id ${externalId}.`, "external_id");
  const segments = await prisma.subscription.findMany({
    where: { organizationId: ctx.organizationId, customerId: row.id },
    select: SEGMENT_SELECT,
  });
  return {
    ...customerWire(row, ctx.currency),
    subscriptions: chainsOf(segments).map((chain) => subscriptionWire(chain, ctx.currency, ctx.now)),
  };
}

export type PutResult<T> = { readonly created: boolean; readonly changed: boolean; readonly record: T };

export async function putCustomer(
  ctx: ApiWriteContext,
  externalId: string,
  body: unknown,
): Promise<PutResult<CustomerDetailWire>> {
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const input = parsed.data;
  const { organizationId } = ctx;

  const existing = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId, externalId } },
    select: { id: true, name: true, email: true, archivedAt: true },
  });
  if (existing === null) {
    applied(ctx, await createCustomerOp(organizationId, { name: input.name, email: input.email ?? null }, { source: ctx.source, externalId }));
    return { created: true, changed: true, record: await getCustomer(ctx, externalId) };
  }

  let changed = false;
  // Pushing a customer is saying it exists: an archived one comes back.
  if (existing.archivedAt !== null) {
    applied(ctx, await setCustomerArchivedOp(organizationId, existing.id, false));
    changed = true;
  }
  const email = input.email === undefined ? existing.email : input.email;
  if (existing.name !== input.name || existing.email !== email) {
    applied(ctx, await updateCustomerOp(organizationId, existing.id, { name: input.name, email }), { name: "name" });
    changed = true;
  }
  return { created: false, changed, record: await getCustomer(ctx, externalId) };
}

/** Archives: history and metrics are kept, as with the UI's Archive. Idempotent. */
export async function archiveCustomer(ctx: ApiWriteContext, externalId: string): Promise<CustomerDetailWire> {
  const existing = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId } },
    select: { id: true, archivedAt: true },
  });
  if (existing === null) throw notFound(`No customer with external_id ${externalId}.`, "external_id");
  if (existing.archivedAt === null) applied(ctx, await setCustomerArchivedOp(ctx.organizationId, existing.id, true));
  return getCustomer(ctx, externalId);
}

const STATUS_FILTERS: Record<string, CustomerFilter> = { active: "active", churned: "churned", all: "all" };

export async function listCustomers(ctx: ApiWriteContext, query: URLSearchParams): Promise<ListBody<CustomerWire>> {
  const page = pageParams(query);
  const rawStatus = query.get("status") ?? "all";
  const filter = STATUS_FILTERS[rawStatus];
  if (filter === undefined) throw invalid("status: Use active, churned or all.", "status");
  const rows = await getCustomerRowsById(
    ctx.organizationId,
    { filter, startingAfter: page.startingAfter, limit: page.limit + 1 },
    ctx.now,
  );
  return listBody(rows, page.limit, (row) => customerWire(row, ctx.currency));
}
