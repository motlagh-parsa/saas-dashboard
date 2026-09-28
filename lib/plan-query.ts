import "server-only";

// The plans table's query: each plan of the workspace with its live
// subscriptions and the MRR they bring in now, searched, filtered, sorted and
// paged in Postgres. MRR follows lib/metrics.ts exactly — amount × quantity ÷
// interval months over live segments, rounded once per plan — and every join is
// tenant-filtered.
import { Prisma, type BillingInterval, type DataSource } from "@prisma/client";

import type { SortDirection } from "@/lib/list-state";
import type { PlanFilter, PlanSortKey } from "@/lib/plan-list";
import { prisma } from "@/lib/prisma";

export interface PlanPageRow {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly source: DataSource;
  readonly archived: boolean;
  /** Live subscriptions on this plan now. */
  readonly activeSubscriptions: number;
  /** Subscriptions that have EVER used this plan — nonzero means it can't be deleted. */
  readonly usedBy: number;
  readonly mrrCents: number;
}

interface SqlRow {
  id: string;
  name: string;
  amountCents: number;
  interval: BillingInterval;
  intervalCount: number;
  source: DataSource;
  archived: boolean;
  active_subscriptions: number;
  used_by: number;
  mrr_cents: bigint | number | string;
}

function planView(organizationId: string, asOf: Date): Prisma.Sql {
  const at = Prisma.sql`${asOf.toISOString()}::timestamp`;
  const live = Prisma.sql`(s."startedAt" <= ${at} AND (s."endedAt" IS NULL OR s."endedAt" > ${at}))`;
  const monthly = Prisma.sql`(s."amountCents"::numeric * s."quantity"
    / ((CASE WHEN s."interval" = 'YEAR'::"BillingInterval" THEN 12 ELSE 1 END) * s."intervalCount"))`;
  return Prisma.sql`
    plan_view AS (
      SELECT
        p.id, p.name, p."amountCents", p.interval, p."intervalCount", p.source,
        p."archivedAt" IS NOT NULL AS archived,
        COUNT(s.id) FILTER (WHERE ${live})::int AS active_subscriptions,
        COUNT(s.id)::int AS used_by,
        ROUND(ROUND(COALESCE(SUM(${monthly}) FILTER (WHERE ${live}), 0), 10))::bigint AS mrr_cents,
        p."amountCents"::numeric
          / ((CASE WHEN p.interval = 'YEAR'::"BillingInterval" THEN 12 ELSE 1 END) * p."intervalCount")
          AS monthly_price
      FROM "Plan" p
      LEFT JOIN "Subscription" s
        ON s."planId" = p.id
       AND s."organizationId" = ${organizationId}
      WHERE p."organizationId" = ${organizationId}
      GROUP BY p.id
    )`;
}

function filterSql(filter: PlanFilter, query: string): Prisma.Sql {
  const status =
    filter === "active" ? Prisma.sql`NOT archived` : filter === "archived" ? Prisma.sql`archived` : Prisma.sql`TRUE`;
  const search = query ? Prisma.sql`strpos(lower(name), ${query.toLowerCase()}) > 0` : Prisma.sql`TRUE`;
  return Prisma.sql`${status} AND ${search}`;
}

function orderSql(sort: PlanSortKey, dir: SortDirection): Prisma.Sql {
  const direction = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
  switch (sort) {
    case "name":
      return Prisma.sql`lower(name) ${direction}, id ASC`;
    case "price":
      return Prisma.sql`monthly_price ${direction}, lower(name) ASC, id ASC`;
    case "subscriptions":
      return Prisma.sql`active_subscriptions ${direction}, lower(name) ASC, id ASC`;
    case "mrr":
      return Prisma.sql`mrr_cents ${direction}, lower(name) ASC, id ASC`;
  }
}

export async function getPlanPage(
  organizationId: string,
  options: {
    readonly query: string;
    readonly sort: PlanSortKey;
    readonly dir: SortDirection;
    readonly filter: PlanFilter;
    readonly page: number;
    readonly perPage: number;
  },
  asOf: Date = new Date(),
): Promise<{ rows: PlanPageRow[]; matching: number; total: number }> {
  const view = planView(organizationId, asOf);
  const where = filterSql(options.filter, options.query);
  const [rows, counts] = await prisma.$transaction(
    [
      prisma.$queryRaw<SqlRow[]>(Prisma.sql`
        WITH ${view}
        SELECT id, name, "amountCents", interval, "intervalCount", source, archived,
               active_subscriptions, used_by, mrr_cents
        FROM plan_view
        WHERE ${where}
        ORDER BY ${orderSql(options.sort, options.dir)}
        LIMIT ${options.perPage} OFFSET ${(options.page - 1) * options.perPage}
      `),
      prisma.$queryRaw<{ matching: number; total: number }[]>(Prisma.sql`
        WITH ${view}
        SELECT COUNT(*) FILTER (WHERE ${where})::int AS matching, COUNT(*)::int AS total
        FROM plan_view
      `),
    ],
    { isolationLevel: "RepeatableRead" },
  );

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      amountCents: row.amountCents,
      interval: row.interval,
      intervalCount: row.intervalCount,
      source: row.source,
      archived: row.archived,
      activeSubscriptions: row.active_subscriptions,
      usedBy: row.used_by,
      mrrCents: Number(row.mrr_cents),
    })),
    matching: counts[0]?.matching ?? 0,
    total: counts[0]?.total ?? 0,
  };
}
