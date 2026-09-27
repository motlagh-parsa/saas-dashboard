// CSV export for the four reports on /dashboard/reports. One dynamic GET route;
// `reportId` picks the query and the column layout.
//
// Security, same order as every protected page:
//   1. `requireSession()` is the authorization gate. An anonymous caller is
//      redirected to /sign-in; the download button detects the redirect.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it. No org id is accepted from the URL or the request body.
//   3. `reportId` is the one untrusted input, and it only ever selects a key of
//      REPORT_BUILDERS. Anything else is a 400 before a query runs.
//
// Money leaves `lib/metrics` as integer cents and is written here as major units
// with two decimals, which is what a spreadsheet expects. Rates are written as
// percentages. An undefined rate (`null`) is an empty cell, not 0.
import "server-only";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import {
  getActiveSubscriptions,
  getChurnRateTrend,
  getMRRTrend,
  getRevenueMovement,
} from "@/lib/metrics";

/** Months of history in every export. Matches the page's "over 12 months" copy. */
const EXPORT_MONTHS = 12;

type CsvCell = string | number | boolean | null;
type CsvRow = readonly CsvCell[];

type ReportBuilder = (organizationId: string) => Promise<CsvRow[]>;

// ---------------------------------------------------------------------------
// CSV encoding
// ---------------------------------------------------------------------------

/** RFC 4180: quote a cell only when it contains a delimiter, a quote, or a newline. */
function encodeCell(cell: CsvCell): string {
  if (cell === null) return "";
  const text = String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function encodeCsv(rows: readonly CsvRow[]): string {
  return rows.map((row) => row.map(encodeCell).join(",")).join("\r\n") + "\r\n";
}

/** Integer cents -> "1234.50". */
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Fraction -> "5.23" (percent). `null` stays null: an undefined rate is not 0%. */
function percent(fraction: number | null): string | null {
  return fraction === null ? null : (fraction * 100).toFixed(2);
}

/** Instant -> UTC calendar date, `YYYY-MM-DD`. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

async function buildMrrSummary(organizationId: string): Promise<CsvRow[]> {
  const trend = await getMRRTrend(organizationId, EXPORT_MONTHS);
  return [
    ["Month", "As of", "MRR", "Active subscriptions", "New subscriptions", "Churned subscriptions"],
    ...trend.map((point): CsvRow => [
      point.month,
      point.asOfDate,
      money(point.mrrCents),
      point.activeSubs,
      point.newSubs,
      point.churnedSubs,
    ]),
  ];
}

async function buildChurnAnalysis(organizationId: string): Promise<CsvRow[]> {
  const trend = await getChurnRateTrend(organizationId, EXPORT_MONTHS);
  return [
    [
      "Month",
      "Period start",
      "Period end",
      "Complete",
      "Active at start",
      "Churned",
      "Churn rate (%)",
    ],
    ...trend.map((point): CsvRow => [
      point.month,
      isoDate(point.period.start),
      isoDate(point.period.end),
      point.isComplete,
      point.activeAtStart,
      point.churned,
      percent(point.rate),
    ]),
  ];
}

async function buildRevenueBridge(organizationId: string): Promise<CsvRow[]> {
  const movement = await getRevenueMovement(organizationId, EXPORT_MONTHS);
  return [
    [
      "Month",
      "Complete",
      "Starting MRR",
      "New",
      "Reactivation",
      "Expansion",
      "Contraction",
      "Churned",
      "Ending MRR",
      "Net change",
      "NRR (%)",
      "GRR (%)",
    ],
    ...movement.map((point): CsvRow => [
      point.month,
      point.isComplete,
      money(point.startingMRRCents),
      money(point.newMRRCents),
      money(point.reactivationMRRCents),
      money(point.expansionMRRCents),
      money(point.contractionMRRCents),
      money(point.churnedMRRCents),
      money(point.endingMRRCents),
      money(point.endingMRRCents - point.startingMRRCents),
      percent(point.nrr),
      percent(point.grr),
    ]),
  ];
}

/**
 * Two sections in one file, separated by a blank row: the monthly MRR and
 * subscription series, then today's live subscriptions by plan tier and by
 * status. Both counts are subscription SEGMENTS, not customers (see the CHAIN VS
 * SEGMENT note in lib/metrics.ts), so the headers say "subscriptions".
 */
async function buildRetentionCohorts(organizationId: string): Promise<CsvRow[]> {
  const [trend, active] = await Promise.all([
    getMRRTrend(organizationId, EXPORT_MONTHS),
    getActiveSubscriptions(organizationId),
  ]);

  return [
    ["Month", "MRR", "Active subscriptions", "New subscriptions", "Churned subscriptions"],
    ...trend.map((point): CsvRow => [
      point.month,
      money(point.mrrCents),
      point.activeSubs,
      point.newSubs,
      point.churnedSubs,
    ]),
    [],
    [`Active subscriptions as of ${isoDate(active.asOf)}`, active.total],
    ["Plan tier", "Subscriptions"],
    ...active.byTier.map((row): CsvRow => [row.tier, row.count]),
    [],
    ["Status", "Subscriptions"],
    ...active.byStatus.map((row): CsvRow => [row.status, row.count]),
  ];
}

/** Keys must match `REPORTS[].id` in components/dashboard/report-catalogue.ts. */
const REPORT_BUILDERS = {
  "mrr-summary": buildMrrSummary,
  "churn-analysis": buildChurnAnalysis,
  "revenue-bridge": buildRevenueBridge,
  "retention-cohorts": buildRetentionCohorts,
} as const satisfies Record<string, ReportBuilder>;

type ReportId = keyof typeof REPORT_BUILDERS;

function isReportId(value: string): value is ReportId {
  return Object.hasOwn(REPORT_BUILDERS, value);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface RouteContext {
  params: Promise<{ reportId: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const session = await requireSession();
  const { reportId } = await params;

  if (!isReportId(reportId)) {
    return Response.json({ error: `Unknown report "${reportId}".` }, { status: 400 });
  }

  // The workspace the dashboard is showing (lib/active-org.ts), so the file
  // matches the page the download button sits on.
  const organizationId = await getActiveOrgId(session.user.id);
  if (organizationId === null) {
    return Response.json({ error: "No workspace for this account." }, { status: 403 });
  }

  const rows = await REPORT_BUILDERS[reportId](organizationId);
  const filename = `${reportId}-${isoDate(new Date())}.csv`;

  return new Response(encodeCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Tenant data: never let a shared cache hold it.
      "Cache-Control": "private, no-store",
    },
  });
}
