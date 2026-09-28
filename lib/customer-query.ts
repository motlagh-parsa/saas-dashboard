import "server-only";

// The customers table's query, shared by the page (one page of rows + counts)
// and `exportCustomersCSV` (every matching row). One definition, so the export
// is exactly what the table would show across all its pages, in the same order.
//
// Search, filter, sort and paging all happen in Postgres: a customer's current
// MRR and status are aggregates over their subscriptions, so sorting by MRR or
// filtering to churned customers cannot be done on a page of rows in JS.
//
// Definitions are lib/metrics.ts's: MRR = amount × quantity ÷ interval months,
// summed exactly and rounded once per customer; live = started and not yet
// ended; active = a live subscription billing > 0. Every join is tenant-filtered.
import { Prisma, type DataSource } from "@prisma/client";

import type { CustomerFilter, CustomerSortKey, CustomerStatus } from "@/lib/customer-list";
import type { SortDirection } from "@/lib/list-state";
import { CUSTOM_PLAN_LABEL } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";

export interface CustomerPageRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly externalId: string | null;
  readonly source: DataSource;
  readonly archived: boolean;
  readonly status: CustomerStatus;
  readonly mrrCents: number;
  /** Plan names of the live subscriptions, comma-joined; null when nothing is live. */
  readonly livePlans: string | null;
  /** First instant the customer was ever active; null if never. */
  readonly customerSince: Date | null;
}

export type CustomerFilterCounts = Readonly<Record<CustomerFilter, number>>;

interface SqlRow {
  id: string;
  name: string;
  email: string | null;
  externalId: string | null;
  source: DataSource;
  archived: boolean;
  status: CustomerStatus;
  mrr_cents: bigint | number | string;
  live_plans: string[] | null;
  first_paid_at: Date | null;
}

interface CountRow {
  all_count: number;
  active_count: number;
  churned_count: number;
  archived_count: number;
}

function ts(value: Date): Prisma.Sql {
  return Prisma.sql`${value.toISOString()}::timestamp`;
}

/**
 * One row per customer of the workspace with their derived figures, as a CTE
 * named `customers_view`. Archived customers are included; the filter decides.
 */
function customersView(organizationId: string, asOf: Date): Prisma.Sql {
  const at = ts(asOf);
  const live = Prisma.sql`(s."startedAt" <= ${at} AND (s."endedAt" IS NULL OR s."endedAt" > ${at}))`;
  const monthly = Prisma.sql`(s."amountCents"::numeric * s."quantity"
    / ((CASE WHEN s."interval" = 'YEAR'::"BillingInterval" THEN 12 ELSE 1 END) * s."intervalCount"))`;
  const paying = Prisma.sql`(${monthly} > 0 AND (s."endedAt" IS NULL OR s."endedAt" > s."startedAt"))`;
  return Prisma.sql`
    customers_view AS (
      SELECT
        c.id,
        c.name,
        c.email,
        c."externalId",
        c.source,
        c."archivedAt" IS NOT NULL AS archived,
        ROUND(ROUND(COALESCE(SUM(${monthly}) FILTER (WHERE ${live}), 0), 10))::bigint AS mrr_cents,
        COALESCE(BOOL_OR(${paying} AND ${live}), false) AS is_active,
        COALESCE(BOOL_OR(s.status = 'PAST_DUE'::"SubscriptionStatus" AND ${live}), false) AS past_due,
        MIN(s."startedAt") FILTER (WHERE ${paying}) AS first_paid_at,
        array_agg(DISTINCT COALESCE(p.name, ${CUSTOM_PLAN_LABEL})) FILTER (WHERE ${live}) AS live_plans
      FROM "Customer" c
      LEFT JOIN "Subscription" s
        ON s."customerId" = c.id
       AND s."organizationId" = ${organizationId}
      LEFT JOIN "Plan" p
        ON p.id = s."planId"
       AND p."organizationId" = ${organizationId}
      WHERE c."organizationId" = ${organizationId}
      GROUP BY c.id
    ),
    classified AS (
      SELECT *,
        CASE
          WHEN is_active AND past_due THEN 'past_due'
          WHEN is_active THEN 'active'
          WHEN first_paid_at IS NOT NULL AND first_paid_at <= ${at} THEN 'churned'
          ELSE 'none'
        END AS status
      FROM customers_view
    )`;
}

function filterSql(filter: CustomerFilter): Prisma.Sql {
  switch (filter) {
    case "all":
      return Prisma.sql`NOT archived`;
    case "active":
      return Prisma.sql`NOT archived AND status IN ('active', 'past_due')`;
    case "churned":
      return Prisma.sql`NOT archived AND status = 'churned'`;
    case "archived":
      return Prisma.sql`archived`;
  }
}

/**
 * Case-insensitive substring match on name, email or external id. `strpos`
 * rather than LIKE, so a `%` or `_` typed into the search box is just a
 * character, not a wildcard.
 */
function searchSql(query: string): Prisma.Sql {
  if (!query) return Prisma.sql`TRUE`;
  const needle = query.toLowerCase();
  return Prisma.sql`(
    strpos(lower(name), ${needle}) > 0
    OR strpos(lower(COALESCE(email, '')), ${needle}) > 0
    OR strpos(lower(COALESCE("externalId", '')), ${needle}) > 0
  )`;
}

/**
 * A total order for every sort, ending on id, so paging never shows a row twice
 * or skips one. Identifiers come from this closed switch, never from input.
 */
function orderSql(sort: CustomerSortKey, dir: SortDirection): Prisma.Sql {
  const direction = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
  switch (sort) {
    case "name":
      return Prisma.sql`lower(name) ${direction}, id ASC`;
    case "mrr":
      return Prisma.sql`mrr_cents ${direction}, lower(name) ASC, id ASC`;
    case "since":
      return Prisma.sql`first_paid_at ${direction} NULLS LAST, lower(name) ASC, id ASC`;
  }
}

function toRow(row: SqlRow): CustomerPageRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    externalId: row.externalId,
    source: row.source,
    archived: row.archived,
    status: row.status,
    mrrCents: Number(row.mrr_cents),
    livePlans:
      row.live_plans === null || row.live_plans.length === 0
        ? null
        : [...row.live_plans].sort((a, b) => a.localeCompare(b)).join(", "),
    customerSince: row.status === "none" ? null : row.first_paid_at,
  };
}

export interface CustomerQuery {
  readonly query: string;
  readonly sort: CustomerSortKey;
  readonly dir: SortDirection;
  readonly filter: CustomerFilter;
}

/** One page of the table, how many rows match in total, and the count behind each filter chip. */
export async function getCustomerPage(
  organizationId: string,
  options: CustomerQuery & { readonly page: number; readonly perPage: number },
  asOf: Date = new Date(),
): Promise<{ rows: CustomerPageRow[]; matching: number; counts: CustomerFilterCounts }> {
  const view = customersView(organizationId, asOf);
  const where = Prisma.sql`${filterSql(options.filter)} AND ${searchSql(options.query)}`;

  const [rows, matchingRows, countRows] = await prisma.$transaction(
    [
      prisma.$queryRaw<SqlRow[]>(Prisma.sql`
        WITH ${view}
        SELECT id, name, email, "externalId", source, archived, status, mrr_cents, live_plans, first_paid_at
        FROM classified
        WHERE ${where}
        ORDER BY ${orderSql(options.sort, options.dir)}
        LIMIT ${options.perPage} OFFSET ${(options.page - 1) * options.perPage}
      `),
      prisma.$queryRaw<{ matching: number }[]>(Prisma.sql`
        WITH ${view}
        SELECT COUNT(*)::int AS matching FROM classified WHERE ${where}
      `),
      // Chip counts honour the search, so "Churned 3" means three of these matches.
      prisma.$queryRaw<CountRow[]>(Prisma.sql`
        WITH ${view}
        SELECT
          COUNT(*) FILTER (WHERE NOT archived)::int AS all_count,
          COUNT(*) FILTER (WHERE NOT archived AND status IN ('active', 'past_due'))::int AS active_count,
          COUNT(*) FILTER (WHERE NOT archived AND status = 'churned')::int AS churned_count,
          COUNT(*) FILTER (WHERE archived)::int AS archived_count
        FROM classified
        WHERE ${searchSql(options.query)}
      `),
    ],
    { isolationLevel: "RepeatableRead" },
  );

  const counts = countRows[0];
  return {
    rows: rows.map(toRow),
    matching: matchingRows[0]?.matching ?? 0,
    counts: {
      all: counts?.all_count ?? 0,
      active: counts?.active_count ?? 0,
      churned: counts?.churned_count ?? 0,
      archived: counts?.archived_count ?? 0,
    },
  };
}

/** Every row the table's current view matches, in its order — for the CSV export. */
export async function getCustomerExportRows(
  organizationId: string,
  options: CustomerQuery,
  asOf: Date = new Date(),
): Promise<CustomerPageRow[]> {
  const rows = await prisma.$queryRaw<SqlRow[]>(Prisma.sql`
    WITH ${customersView(organizationId, asOf)}
    SELECT id, name, email, "externalId", source, archived, status, mrr_cents, live_plans, first_paid_at
    FROM classified
    WHERE ${filterSql(options.filter)} AND ${searchSql(options.query)}
    ORDER BY ${orderSql(options.sort, options.dir)}
  `);
  return rows.map(toRow);
}
