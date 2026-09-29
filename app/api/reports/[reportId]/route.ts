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
import { neutralizeFormula } from "@/lib/csv/write";
import { currencyFractionDigits } from "@/lib/format";
import {
  getChurnRateTrend,
  getMRRTrend,
  getOrganizationCurrency,
  getPlanMix,
  getRevenueMovement,
} from "@/lib/metrics";

/** Months of history in every export. Matches the page's "over 12 months" copy. */
const EXPORT_MONTHS = 12;

type CsvCell = string | number | boolean | null;
type CsvRow = readonly CsvCell[];

type ReportBuilder = (organizationId: string, currency: string) => Promise<CsvRow[]>;

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

/** Integer minor units -> "1234.50" ("1234" for a zero-decimal currency like JPY). */
function money(cents: number, currency: string): string {
  const digits = currencyFractionDigits(currency);
  return (cents / 10 ** digits).toFixed(digits);
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
//
// Every money column is in the workspace's single currency, and its header says
// which — a CSV cell carries no currency symbol, and a file travels without the
// page that explains it.
// ---------------------------------------------------------------------------

async function buildMrrSummary(organizationId: string, currency: string): Promise<CsvRow[]> {
  const trend = await getMRRTrend(organizationId, EXPORT_MONTHS);
  return [
    ["Month", "As of", `MRR (${currency})`, "Active customers", "New customers", "Churned customers"],
    ...trend.map((point): CsvRow => [
      point.month,
      point.asOfDate,
      money(point.mrrCents, currency),
      point.activeCustomers,
      point.newCustomers,
      point.churnedCustomers,
    ]),
  ];
}

async function buildChurnAnalysis(organizationId: string, currency: string): Promise<CsvRow[]> {
  const trend = await getChurnRateTrend(organizationId, EXPORT_MONTHS);
  return [
    [
      "Month",
      "Period start",
      "Period end",
      "Complete",
      "Customers at start",
      "Churned customers",
      "Customer churn (%)",
      `Starting MRR (${currency})`,
      `Churned MRR (${currency})`,
      "Revenue churn (%)",
    ],
    ...trend.map((point): CsvRow => [
      point.month,
      isoDate(point.period.start),
      isoDate(point.period.end),
      point.isComplete,
      point.customersAtStart,
      point.churnedCustomers,
      percent(point.rate),
      money(point.startingMRRCents, currency),
      money(point.churnedMRRCents, currency),
      percent(point.revenueRate),
    ]),
  ];
}

async function buildRevenueBridge(organizationId: string, currency: string): Promise<CsvRow[]> {
  const movement = await getRevenueMovement(organizationId, EXPORT_MONTHS);
  return [
    [
      "Month",
      "Complete",
      `Starting MRR (${currency})`,
      "New",
      "Reactivation",
      "Expansion",
      "Contraction",
      "Churned",
      `Ending MRR (${currency})`,
      "Net change",
      "Paying customers at start",
      "New customers",
      "Reactivated customers",
      "Churned customers",
      "NRR (%)",
      "GRR (%)",
    ],
    ...movement.map((point): CsvRow => [
      point.month,
      point.isComplete,
      money(point.startingMRRCents, currency),
      money(point.newMRRCents, currency),
      money(point.reactivationMRRCents, currency),
      money(point.expansionMRRCents, currency),
      money(point.contractionMRRCents, currency),
      money(point.churnedMRRCents, currency),
      money(point.endingMRRCents, currency),
      money(point.endingMRRCents - point.startingMRRCents, currency),
      point.payingCustomersAtStart,
      point.newCustomers,
      point.reactivatedCustomers,
      point.churnedCustomers,
      percent(point.nrr),
      percent(point.grr),
    ]),
  ];
}

/**
 * Two sections in one file, separated by a blank row: the monthly MRR and
 * customer series, then today's live MRR by plan.
 */
async function buildRetentionCohorts(organizationId: string, currency: string): Promise<CsvRow[]> {
  const [trend, planMix] = await Promise.all([
    getMRRTrend(organizationId, EXPORT_MONTHS),
    getPlanMix(organizationId),
  ]);

  return [
    ["Month", `MRR (${currency})`, "Active customers", "New customers", "Churned customers"],
    ...trend.map((point): CsvRow => [
      point.month,
      money(point.mrrCents, currency),
      point.activeCustomers,
      point.newCustomers,
      point.churnedCustomers,
    ]),
    [],
    [`Live MRR by plan as of ${isoDate(planMix.asOf)} (${currency})`, money(planMix.totalMRRCents, currency)],
    ["Plan", `MRR (${currency})`, "Subscriptions"],
    ...planMix.byPlan.map((row): CsvRow => [
      // A founder types plan names, so one could start with "=": neutralized
      // like every other user-typed cell in an export (lib/csv.ts).
      neutralizeFormula(row.name),
      money(row.mrrCents, currency),
      row.subscriptions,
    ]),
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

  const currency = await getOrganizationCurrency(organizationId);
  const rows = await REPORT_BUILDERS[reportId](organizationId, currency);
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
