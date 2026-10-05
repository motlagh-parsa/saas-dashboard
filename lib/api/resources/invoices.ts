import "server-only";

// /v1/invoices — upsert by the caller's ID, and list.
//
// A new invoice is recorded as the UI's Record invoice records it. Void and
// uncollectible are not states the UI records directly; they are reached from
// open, so an invoice pushed in one of them is recorded open and then moved,
// both through the UI's operations. An existing invoice changes only by status,
// along the UI's transitions (lib/billing-ops.ts TRANSITIONS); its amount,
// customer and dates are a financial record and never edited — the UI has no
// edit either — so a PUT that differs there is a 409.
import type { InvoiceStatus, Prisma } from "@prisma/client";
import { z } from "zod";

import { recordInvoiceOp, transitionInvoiceOp } from "@/lib/billing-ops";
import { formatEnumLabel } from "@/lib/format";
import { prisma } from "@/lib/prisma";

import { applied, type ApiWriteContext } from "../context";
import { conflict, invalid, notFound, parseBody } from "../errors";
import { amountSchema, dayParam, daySchema, externalIdSchema, listBody, pageParams, wireDay, wireEnum, type ListBody } from "../schema";
import { findChain } from "./chains";
import type { PutResult } from "./customers";

const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;

const statusSchema = z
  .enum(STATUSES, { error: `Use one of ${STATUSES.join(", ")}.` })
  .transform((value) => value.toUpperCase() as InvoiceStatus);

const putSchema = z
  .strictObject({
    customer_external_id: externalIdSchema,
    subscription_external_id: externalIdSchema.nullable().optional(),
    amount: amountSchema({ allowZero: false }),
    status: statusSchema,
    issued_at: daySchema(),
    due_at: daySchema().nullable().optional(),
    paid_at: daySchema("today").nullable().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.due_at && values.due_at < values.issued_at) {
      ctx.addIssue({ code: "custom", path: ["due_at"], message: "due_at can't be before issued_at." });
    }
    if (values.status === "PAID") {
      if (!values.paid_at) ctx.addIssue({ code: "custom", path: ["paid_at"], message: "A paid invoice needs paid_at." });
      else if (values.paid_at < values.issued_at) {
        ctx.addIssue({ code: "custom", path: ["paid_at"], message: "paid_at can't be before issued_at." });
      }
    } else if (values.paid_at) {
      ctx.addIssue({ code: "custom", path: ["paid_at"], message: "Send paid_at only with status paid." });
    }
  });

const INVOICE_SELECT = {
  id: true,
  externalId: true,
  customerId: true,
  subscriptionId: true,
  amountCents: true,
  status: true,
  issuedAt: true,
  dueAt: true,
  paidAt: true,
  source: true,
  createdAt: true,
  customer: { select: { externalId: true } },
  subscription: { select: { externalId: true } },
} as const satisfies Prisma.InvoiceSelect;

type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

export interface InvoiceWire {
  readonly object: "invoice";
  readonly id: string;
  readonly external_id: string | null;
  readonly customer_external_id: string | null;
  /** The subscription it bills, by the caller's ID; null for a one-off charge. */
  readonly subscription_external_id: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: Lowercase<InvoiceStatus>;
  readonly issued_at: string;
  readonly due_at: string | null;
  readonly paid_at: string | null;
  readonly source: string;
}

function invoiceWire(row: InvoiceRow, currency: string): InvoiceWire {
  const segmentId = row.subscription?.externalId ?? null;
  const colon = segmentId?.lastIndexOf(":") ?? -1;
  return {
    object: "invoice",
    id: row.id,
    external_id: row.externalId,
    customer_external_id: row.customer.externalId,
    subscription_external_id: segmentId !== null && colon > 0 ? segmentId.slice(0, colon) : null,
    amount: row.amountCents,
    currency,
    status: wireEnum(row.status),
    issued_at: wireDay(row.issuedAt),
    due_at: wireDay(row.dueAt),
    paid_at: wireDay(row.paidAt),
    source: wireEnum(row.source),
  };
}

async function readInvoice(ctx: ApiWriteContext, externalId: string): Promise<InvoiceRow | null> {
  return prisma.invoice.findUnique({
    where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId } },
    select: INVOICE_SELECT,
  });
}

const TRANSITION_TO = { PAID: "paid", VOID: "void", UNCOLLECTIBLE: "uncollectible" } as const;

function refusedTransition(from: InvoiceStatus, to: InvoiceStatus): never {
  // The UI's own wording for a transition it does not offer.
  throw conflict(
    `A ${formatEnumLabel(from).toLowerCase()} invoice can't be marked ${formatEnumLabel(to).toLowerCase()}.`,
    "status",
  );
}

export async function putInvoice(ctx: ApiWriteContext, externalId: string, body: unknown): Promise<PutResult<InvoiceWire>> {
  const input = parseBody(putSchema, body, (raw) =>
    raw.status === "paid" && (raw.paid_at === undefined || raw.paid_at === null)
      ? [{ param: "paid_at", message: "A paid invoice needs paid_at." }]
      : [],
  );
  const { organizationId, currency } = ctx;

  const customer = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId, externalId: input.customer_external_id } },
    select: { id: true },
  });
  if (customer === null) throw notFound(`No customer with external_id ${input.customer_external_id}.`, "customer_external_id");

  // The segment it bills: the one live on the issue date, else the chain's latest.
  let subscriptionId: string | null = null;
  if (input.subscription_external_id) {
    const chain = await findChain(organizationId, input.subscription_external_id);
    if (chain === null) {
      throw notFound(`No subscription with external_id ${input.subscription_external_id}.`, "subscription_external_id");
    }
    const issued = input.issued_at.getTime();
    const live = chain.find(
      (segment) => segment.startedAt.getTime() <= issued && (segment.endedAt === null || segment.endedAt.getTime() > issued),
    );
    subscriptionId = (live ?? chain[chain.length - 1])?.id ?? null;
  }

  const existing = await readInvoice(ctx, externalId);
  if (existing === null) {
    const recordAs = input.status === "VOID" || input.status === "UNCOLLECTIBLE" ? "OPEN" : input.status;
    const created = applied(
      ctx,
      await recordInvoiceOp(
        organizationId,
        currency,
        {
          customerId: customer.id,
          subscriptionId,
          amount: input.amount,
          issuedDate: input.issued_at,
          dueDate: input.due_at ?? null,
          status: recordAs,
          paidDate: input.paid_at ?? null,
        },
        { source: "API", externalId },
      ),
      { customerId: "customer_external_id", subscriptionId: "subscription_external_id", amount: "amount", paidDate: "paid_at" },
    );
    if (input.status === "VOID" || input.status === "UNCOLLECTIBLE") {
      applied(ctx, await transitionInvoiceOp(organizationId, currency, created.id, TRANSITION_TO[input.status]), { paidDate: "paid_at" });
    }
    const record = await readInvoice(ctx, externalId);
    if (record === null) throw new Error("invoice vanished after create");
    return { created: true, changed: true, record: invoiceWire(record, currency) };
  }

  const fixed: [string, boolean][] = [
    ["customer_external_id", existing.customerId !== customer.id],
    ["amount", existing.amountCents !== input.amount],
    ["issued_at", existing.issuedAt.getTime() !== input.issued_at.getTime()],
    ["due_at", input.due_at !== undefined && (existing.dueAt?.getTime() ?? null) !== (input.due_at?.getTime() ?? null)],
    ["subscription_external_id", input.subscription_external_id !== undefined && existing.subscriptionId !== subscriptionId],
  ];
  const differs = fixed.find(([, changed]) => changed);
  if (differs !== undefined) {
    throw conflict(
      `An invoice's ${differs[0]} can't be changed once recorded. Void it and push a new invoice instead.`,
      differs[0],
    );
  }

  let changed = false;
  if (existing.status !== input.status) {
    const to = input.status;
    if (to === "DRAFT" || to === "OPEN") refusedTransition(existing.status, to);
    applied(
      ctx,
      await transitionInvoiceOp(organizationId, currency, existing.id, TRANSITION_TO[to], to === "PAID" ? (input.paid_at ?? null) : null),
      { paidDate: "paid_at" },
    );
    changed = true;
  } else if (input.status === "PAID" && (existing.paidAt?.getTime() ?? null) !== (input.paid_at?.getTime() ?? null)) {
    throw conflict("A paid invoice's paid_at can't be changed.", "paid_at");
  }

  const record = await readInvoice(ctx, externalId);
  return { created: false, changed, record: invoiceWire(record ?? existing, currency) };
}

export async function getInvoice(ctx: ApiWriteContext, externalId: string): Promise<InvoiceWire> {
  const row = await readInvoice(ctx, externalId);
  if (row === null) throw notFound(`No invoice with external_id ${externalId}.`, "external_id");
  return invoiceWire(row, ctx.currency);
}

export async function listInvoices(ctx: ApiWriteContext, query: URLSearchParams): Promise<ListBody<InvoiceWire>> {
  const page = pageParams(query);
  const where: Prisma.InvoiceWhereInput = { organizationId: ctx.organizationId };

  const rawStatus = query.get("status");
  if (rawStatus !== null) {
    const status = statusSchema.safeParse(rawStatus);
    if (!status.success) throw invalid(`status: Use one of ${STATUSES.join(", ")}.`, "status");
    where.status = status.data;
  }
  const customerExternalId = query.get("customer_external_id");
  if (customerExternalId !== null) {
    const customer = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId: customerExternalId } },
      select: { id: true },
    });
    if (customer === null) throw notFound(`No customer with external_id ${customerExternalId}.`, "customer_external_id");
    where.customerId = customer.id;
  }
  const after = dayParam(query, "issued_after");
  const before = dayParam(query, "issued_before");
  if (after !== null || before !== null) {
    // Both bounds exclusive, by issue day: issued_after=2025-01-31 starts at February 1.
    where.issuedAt = { ...(after === null ? {} : { gt: after }), ...(before === null ? {} : { lt: before }) };
  }
  if (page.startingAfter !== null) where.id = { gt: page.startingAfter };

  const rows = await prisma.invoice.findMany({ where, orderBy: { id: "asc" }, take: page.limit + 1, select: INVOICE_SELECT });
  return listBody(rows, page.limit, (row) => invoiceWire(row, ctx.currency));
}
