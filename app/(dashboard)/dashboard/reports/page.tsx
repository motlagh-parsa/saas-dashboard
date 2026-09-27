// Reports. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// Two real reads, both from `ReportRun` for the caller's workspace: each card's
// "Last generated" line (the latest run per report, or "Never") and the Recent
// exports register (the newest runs across all reports). The report definitions
// themselves are static catalogue copy.
//
// Data flow, in order:
//   1. `requireSession()` is the authorization gate. Middleware is edge-only and
//      is NOT authz; the line is held server-side in every protected page.
//   2. The organization is resolved SERVER-SIDE by lib/active-org.ts: the
//      workspace picked in the switcher, honoured only while the caller is a
//      member of it, else their most privileged one.
//   3. One grouped query for the latest run per report. Relative times are
//      formatted HERE, against one `now`, so the client cards receive finished
//      strings and hydrate with exactly the text the server rendered.
//
// The page stays a Server Component. Interactivity lives in three small client
// islands, each owning only its own state:
//   - `ScheduleReportDialog` — the header action and its dialog. Not live: saving
//     is `aria-disabled` with a stated reason until a schedule model exists.
//   - `ReportCard`           — "Generate" records a REAL `ReportRun` via POST
//     /api/reports/[reportId]/generate, and the footer reads "Just now".
//   - `ExportDownloadButton` — a REAL CSV of the workspace's metrics, fetched from
//     /api/reports/[reportId]. Built on demand: a run stores no file, so every
//     row downloads the CURRENT 12 months, whenever that run happened.
// The report catalogue and export file types live in `report-catalogue.ts` so the
// page and the islands read one source.
import type { Metadata } from "next";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { formatCount, formatRelativeTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { Card, CardAction, CardFooter, CardHeader } from "@/components/ui/card";
import { ExportDownloadButton } from "@/components/dashboard/export-download-button";
import { ReportCard } from "@/components/dashboard/report-card";
import {
  REPORTS,
  type ExportFormat,
} from "@/components/dashboard/report-catalogue";
import { ScheduleReportDialog } from "@/components/dashboard/schedule-report-dialog";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = {
  title: "Reports",
  description: "Saved metric views and scheduled exports for your workspace.",
};

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

/** Column headers wear the same mono caps as every other register in the app. */
const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Footnote voice, shared by the card footers and the table's closing line. */
const FOOTNOTE = "text-[0.6875rem] text-muted-foreground";

// ---------------------------------------------------------------------------
// Recent exports
// ---------------------------------------------------------------------------

/** Rows in the register. The newest runs; older ones simply drop off the end. */
const RECENT_RUN_LIMIT = 10;

/** Every report route exports `EXPORT_MONTHS = 12` months of history. */
const EXPORT_PERIOD = "Last 12 months";

/** The route only produces CSV. Typed against the catalogue's closed format set. */
const EXPORT_FORMAT: ExportFormat = "CSV";

/** Catalogue ids — runs are only ever read for reports the page can render. */
const REPORT_IDS: readonly string[] = REPORTS.map((report) => report.id);

const REPORT_NAMES: ReadonlyMap<string, string> = new Map(
  REPORTS.map((report) => [report.id, report.name]),
);

interface RecentRun {
  readonly id: string;
  readonly reportId: string;
  readonly generatedAt: Date;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Latest run per catalogue report for one workspace, keyed by report id.
 *
 * `groupBy` + `_max` rather than `findMany` and de-duplicating in JS: it returns
 * at most one row per report however many runs exist, and it walks the
 * `[organizationId, reportId, generatedAt]` index directly.
 */
async function getLastRuns(organizationId: string): Promise<Map<string, Date>> {
  const groups = await prisma.reportRun.groupBy({
    by: ["reportId"],
    where: { organizationId, reportId: { in: [...REPORT_IDS] } },
    _max: { generatedAt: true },
  });

  const lastRuns = new Map<string, Date>();
  for (const group of groups) {
    if (group._max.generatedAt !== null) lastRuns.set(group.reportId, group._max.generatedAt);
  }
  return lastRuns;
}

/** The workspace's newest runs across every catalogue report, newest first. */
function getRecentRuns(organizationId: string): Promise<RecentRun[]> {
  return prisma.reportRun.findMany({
    where: { organizationId, reportId: { in: [...REPORT_IDS] } },
    orderBy: { generatedAt: "desc" },
    take: RECENT_RUN_LIMIT,
    select: { id: true, reportId: true, generatedAt: true },
  });
}

export default async function ReportsPage() {
  const session = await requireSession();

  // Tenant resolution: the workspace picked in the switcher (verified against the
  // caller's memberships), else their most privileged one — lib/active-org.ts.
  // The generate route resolves through the same function, so runs are written
  // to the workspace this page reads them from.
  const organizationId = await getActiveOrgId(session.user.id);

  // No workspace means no runs — every card keeps its catalogue copy, the register
  // shows its empty row, and "Generate" answers with the route's own 403 message.
  const [lastRuns, recentRuns] =
    organizationId === null
      ? [new Map<string, Date>(), []]
      : await Promise.all([getLastRuns(organizationId), getRecentRuns(organizationId)]);
  const now = new Date();

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            Exportable summaries of your workspace metrics
          </p>
        </div>
        {/* Pre-filled with the signed-in user's own address. A provider may
            withhold it, in which case the field starts empty. */}
        <ScheduleReportDialog defaultEmail={session.user.email ?? ""} />
      </header>

      {/*
        Hierarchy. These four cards ARE equal weight, and that is the exception
        that proves the rule rather than a lapse: this is a CATALOGUE — a menu of
        four artifacts you can ask for — not four KPIs competing to be read. No
        report outranks another, so ranking them with size would be a lie. The
        page's weight sits in the register below instead, which is the densest
        object on the screen and runs edge to edge.

        No second heading over the grid: the h1 already names it.
      */}
      <section
        aria-label="Available reports"
        className="rise mt-3 grid gap-3 [animation-delay:60ms] sm:grid-cols-2 xl:grid-cols-4"
      >
        {REPORTS.map((report) => {
          const Icon = report.icon;
          const lastGeneratedAt = lastRuns.get(report.id) ?? null;

          // The icon is rendered here and handed over as an element: a component
          // function cannot cross into a client component as a prop.
          return (
            // Keyed by workspace as well as report: a card seeds its footer state
            // from props, and a workspace switch refreshes the page in place — so
            // without the org in the key, the old workspace's run times would stay.
            <ReportCard
              key={`${organizationId ?? "no-workspace"}:${report.id}`}
              reportId={report.id}
              name={report.name}
              description={report.description}
              initialLastGenerated={
                lastGeneratedAt === null
                  ? report.lastGenerated
                  : formatRelativeTime(lastGeneratedAt, now)
              }
              lastGeneratedAt={lastGeneratedAt}
              icon={
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
              }
            />
          );
        })}
      </section>

      {/*
        The register runs edge to edge inside its card: `py-0` lets the table's own
        row rules reach the card's sides, which is what makes a list of files read
        as a ledger rather than a stack of rows floating in padding. Same treatment
        as the members table and the invoice ledger.
      */}
      <section className="rise [animation-delay:120ms]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border pt-4">
            <div className="flex flex-col gap-1">
              <h2 className={EYEBROW}>Recent exports</h2>
              <p className={FOOTNOTE}>
                Reports generated in this workspace, newest first.
              </p>
            </div>
            <CardAction>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {formatCount(recentRuns.length)}{" "}
                {recentRuns.length === 1 ? "export" : "exports"}
              </span>
            </CardAction>
          </CardHeader>

          <Table>
            <TableCaption className="sr-only">
              Recent report runs, newest first, with the period each covers, its file
              format, and when it was generated.
            </TableCaption>

            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className={cn(TABLE_HEAD, "pl-4")}>Report</TableHead>
                <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>
                  Period
                </TableHead>
                <TableHead className={cn(TABLE_HEAD, "hidden sm:table-cell")}>
                  Format
                </TableHead>
                <TableHead className={TABLE_HEAD}>Generated</TableHead>
                <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                  Download
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {recentRuns.length === 0 ? (
                <TableRow className="border-border hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="px-4 py-10 text-center text-[0.8125rem] text-muted-foreground"
                  >
                    No exports yet. Click Generate to create your first report.
                  </TableCell>
                </TableRow>
              ) : null}

              {recentRuns.map((run) => {
                // Filtered to catalogue ids in the query, so the fallback is
                // defensive only.
                const report = REPORT_NAMES.get(run.reportId) ?? run.reportId;

                return (
                  <TableRow key={run.id} className="border-border">
                    <TableCell className="py-2.5 pl-4">
                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="font-medium text-foreground">{report}</span>
                        {/* Below `sm` the Period and Format columns are gone, so they
                            ride under the name instead of being dropped. */}
                        <span className="font-mono text-[0.6875rem] text-muted-foreground sm:hidden">
                          {EXPORT_PERIOD}
                          <span aria-hidden className="px-1.5 text-muted-foreground/40">
                            ·
                          </span>
                          {EXPORT_FORMAT}
                        </span>
                      </div>
                    </TableCell>
  
                    <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                      {EXPORT_PERIOD}
                    </TableCell>
  
                    {/*
                      Plain mono caps, not a Badge. This table reserves badges for
                      STATE — the invoice ledger uses them for paid/open/overdue —
                      and a file format is a property of the artifact, not a status
                      it can move between.
                    */}
                    <TableCell className="hidden py-2.5 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase sm:table-cell">
                      {EXPORT_FORMAT}
                    </TableCell>
  
                    <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">
                      <time dateTime={run.generatedAt.toISOString()}>
                        {formatRelativeTime(run.generatedAt, now)}
                      </time>
                    </TableCell>
  
                    <TableCell className="py-2.5 pr-4 text-right">
                      <ExportDownloadButton
                        reportId={run.reportId}
                        report={report}
                        period={EXPORT_PERIOD.toLowerCase()}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* A run records THAT a report was generated, not a copy of the file. Say
              so where the download buttons are, rather than let a row from last
              week imply it hands back last week's numbers. */}
          <CardFooter className={FOOTNOTE}>
            Downloads are built on demand from current data, not stored copies.
          </CardFooter>
        </Card>
      </section>
    </main>
  );
}
