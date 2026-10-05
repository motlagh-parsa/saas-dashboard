import "server-only";

// /v1/plans — upsert by the caller's ID, and list. A subscription copies its
// plan's price when it starts, so repricing a plan here (as in the UI) affects
// new subscriptions only.
import type { Plan } from "@prisma/client";
import { z } from "zod";

import { createPlanOp, setPlanArchivedOp, updatePlanOp } from "@/lib/billing-ops";
import { prisma } from "@/lib/prisma";

import { applied, type ApiWriteContext } from "../context";
import { validationError } from "../errors";
import {
  amountSchema,
  checkIntervalCount,
  intervalCountSchema,
  intervalSchema,
  listBody,
  pageParams,
  planNameSchema,
  wireEnum,
  wireInterval,
  wireInstant,
  type ListBody,
} from "../schema";
import type { PutResult } from "./customers";

const putSchema = z
  .strictObject({
    name: planNameSchema,
    amount: amountSchema({ allowZero: true }),
    interval: intervalSchema,
    interval_count: intervalCountSchema.optional(),
  })
  .superRefine((values, ctx) => {
    if (values.interval_count !== undefined) checkIntervalCount(values.interval, values.interval_count, ctx, ["interval_count"]);
  });

export interface PlanWire {
  readonly object: "plan";
  readonly id: string;
  readonly external_id: string | null;
  readonly name: string;
  readonly amount: number;
  readonly currency: string;
  readonly interval: "month" | "year";
  readonly interval_count: number;
  readonly archived: boolean;
  readonly source: string;
  readonly created_at: string | null;
}

type PlanRow = Pick<Plan, "id" | "externalId" | "name" | "amountCents" | "interval" | "intervalCount" | "archivedAt" | "source" | "createdAt">;

const PLAN_SELECT = {
  id: true,
  externalId: true,
  name: true,
  amountCents: true,
  interval: true,
  intervalCount: true,
  archivedAt: true,
  source: true,
  createdAt: true,
} as const;

function planWire(plan: PlanRow, currency: string): PlanWire {
  return {
    object: "plan",
    id: plan.id,
    external_id: plan.externalId,
    name: plan.name,
    amount: plan.amountCents,
    currency,
    interval: wireInterval(plan.interval),
    interval_count: plan.intervalCount,
    archived: plan.archivedAt !== null,
    source: wireEnum(plan.source),
    created_at: wireInstant(plan.createdAt),
  };
}

async function readPlan(ctx: ApiWriteContext, externalId: string): Promise<PlanRow | null> {
  return prisma.plan.findUnique({
    where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId } },
    select: PLAN_SELECT,
  });
}

export async function putPlan(ctx: ApiWriteContext, externalId: string, body: unknown): Promise<PutResult<PlanWire>> {
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const input = {
    name: parsed.data.name,
    price: parsed.data.amount,
    interval: parsed.data.interval,
    intervalCount: parsed.data.interval_count ?? 1,
  };
  const params = { name: "name", price: "amount", interval: "interval", intervalCount: "interval_count" };
  const { organizationId, currency } = ctx;

  const existing = await readPlan(ctx, externalId);
  if (existing === null) {
    applied(ctx, await createPlanOp(organizationId, currency, input, { source: "API", externalId }), params);
  } else {
    let changed = false;
    if (existing.archivedAt !== null) {
      applied(ctx, await setPlanArchivedOp(organizationId, existing.id, false));
      changed = true;
    }
    const same =
      existing.name === input.name &&
      existing.amountCents === input.price &&
      existing.interval === input.interval &&
      existing.intervalCount === input.intervalCount;
    if (!same) {
      applied(ctx, await updatePlanOp(organizationId, currency, existing.id, input), params);
      changed = true;
    }
    const record = await readPlan(ctx, externalId);
    return { created: false, changed, record: planWire(record ?? existing, currency) };
  }
  const record = await readPlan(ctx, externalId);
  if (record === null) throw new Error("plan vanished after create");
  return { created: true, changed: true, record: planWire(record, currency) };
}

export async function listPlans(ctx: ApiWriteContext, query: URLSearchParams): Promise<ListBody<PlanWire>> {
  const page = pageParams(query);
  const rows = await prisma.plan.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(page.startingAfter === null ? {} : { id: { gt: page.startingAfter } }),
    },
    orderBy: { id: "asc" },
    take: page.limit + 1,
    select: PLAN_SELECT,
  });
  return listBody(rows, page.limit, (row) => planWire(row, ctx.currency));
}
