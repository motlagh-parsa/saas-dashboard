// Reports. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// This page has NO data layer. Every report definition and every export row below
// is a hardcoded demo object, and every timestamp is a hand-written display
// string, not a value derived from `Date.now()`. Computing real elapsed time
// against invented content would be fake precision: nothing here was generated,
// so "3 days ago" is copy, not a measurement. Same rule the notifications page
// already holds.
//
// `requireSession()` is still the first statement and its result is discarded on
// purpose. Middleware is edge-only and is NOT authz; the security line is held
// server-side in every protected page, including the ones with nothing to leak.
//
// UI ONLY. "Schedule report", every "Generate" and every "Download" is inert —
// `type="button"`, no handler, no action, nothing written and nothing fetched.
// Generation and export are a separate hand-off.
import type { ComponentType } from "react";
import type { Metadata } from "next";
import {
  ArrowLeftRight,
  CalendarClock,
  Download,
  PieChart,
  Repeat,
  UserMinus,
} from "lucide-react";

import { requireSession } from "@/lib/auth";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
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
// The report catalogue
// ---------------------------------------------------------------------------

interface ReportDefinition {
  readonly id: string;
  readonly name: string;
  /** One line. What the report contains, in this product's own vocabulary. */
  readonly description: string;
  /**
   * Same shape `nav-items.ts` uses for its icons, plus `aria-hidden`: the mark is
   * decorative here — the report's name is rendered immediately beside it — so
   * the component has to accept being hidden from the accessibility tree.
   */
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /**
   * A literal display string, written by hand. NOT derived from a `Date`, and
   * NOT rendered in a `<time>` element — there is no real datetime to put in a
   * `dateTime` attribute.
   */
  readonly lastGenerated: string;
}

/**
 * Four reports, and the copy is deliberately this product's language rather than
 * generic BI phrasing:
 *
 *   - "Revenue bridge" is the app's own established term for net MRR movement
 *     broken into new / expansion / contraction / churn — the same four rows the
 *     `BridgePanel` on the revenue page draws, and the same four fields
 *     `RevenueMovementPoint` reports.
 *   - "NRR and GRR" are distinct measures, not synonyms: NRR counts expansion,
 *     GRR does not and can never exceed 100%. Saying both is the point of a
 *     cohort report.
 *
 * Icons are reused from where each concept already lives in the product, so the
 * catalogue and the pages it exports from agree: `UserMinus` from the churn tile,
 * `ArrowLeftRight` from the revenue bridge's own empty state, `Repeat` from the
 * NRR tile. `PieChart` is the only new one, and it is a breakdown-by-category
 * mark on purpose — `TrendingUp` is the Revenue nav item and means a trend.
 */
const REPORTS: readonly ReportDefinition[] = [
  {
    id: "mrr-summary",
    name: "MRR Summary",
    description: "Monthly recurring revenue breakdown by plan tier.",
    icon: PieChart,
    lastGenerated: "Today at 09:00",
  },
  {
    id: "churn-analysis",
    name: "Churn Analysis",
    description: "Cancelled subscriptions and MRR lost per period.",
    icon: UserMinus,
    lastGenerated: "Yesterday at 18:30",
  },
  {
    id: "revenue-bridge",
    name: "Revenue Bridge",
    description: "Net MRR movement: new, expansion, contraction, churn.",
    icon: ArrowLeftRight,
    lastGenerated: "3 days ago",
  },
  {
    id: "retention-cohorts",
    name: "Retention Cohorts",
    description: "NRR and GRR by cohort over 12 months.",
    icon: Repeat,
    lastGenerated: "1 week ago",
  },
];

// ---------------------------------------------------------------------------
// Recent exports
// ---------------------------------------------------------------------------

/** A closed union, not a free string: an unknown format should not reach a cell. */
type ExportFormat = "PDF" | "CSV";

interface ExportRow {
  readonly id: string;
  /** Matches a `ReportDefinition.name` — these are runs of the catalogue above. */
  readonly report: string;
  /** The window the export covers, not when it was produced. */
  readonly period: string;
  readonly format: ExportFormat;
  /** A literal display string, hand-written. Same rule as `lastGenerated`. */
  readonly generated: string;
}

/**
 * Newest first, and reconciled against the cards above on purpose: the most
 * recent run of each report agrees with that report's "Last generated" line, and
 * MRR Summary appears twice because it is the one anyone actually re-runs — once
 * for last month, once for the quarter. Two rows with the same name and the same
 * period would just read as a duplicated row.
 */
const EXPORTS: readonly ExportRow[] = [
  {
    id: "exp-mrr-aug",
    report: "MRR Summary",
    period: "August 2026",
    format: "PDF",
    generated: "4 hours ago",
  },
  {
    id: "exp-churn-aug",
    report: "Churn Analysis",
    period: "August 2026",
    format: "CSV",
    generated: "Yesterday",
  },
  {
    id: "exp-bridge-q2",
    report: "Revenue Bridge",
    period: "Q2 2026",
    format: "PDF",
    generated: "3 days ago",
  },
  {
    id: "exp-mrr-q2",
    report: "MRR Summary",
    period: "Q2 2026",
    format: "CSV",
    generated: "6 days ago",
  },
  {
    id: "exp-cohorts-ttm",
    report: "Retention Cohorts",
    period: "Sep 2025 – Aug 2026",
    format: "PDF",
    generated: "1 week ago",
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ReportsPage() {
  await requireSession();

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            Exportable summaries of your workspace metrics
          </p>
        </div>
        {/*
          The page's one primary action, and the only brass on the screen — same
          treatment Settings gives "Invite member". Scheduling is the durable
          action; generating is something you do once. Inert by design:
          `type="button"` so it can never submit a form it is nested inside.
        */}
        <Button
          type="button"
          className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9"
        >
          <CalendarClock />
          Schedule report
        </Button>
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

          return (
            <Card key={report.id} size="sm" className="h-full gap-2.5">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground/70"
                  />
                  {/*
                    Sentence case, not the mono-caps eyebrow. A report is a NAMED
                    ARTIFACT, like an invoice or a member — mono caps is reserved
                    for labels and panel subjects. It also keeps four titles
                    legible at the xl column width.
                  */}
                  <h2 className="font-heading text-[0.8125rem] leading-snug font-medium text-foreground">
                    {report.name}
                  </h2>
                </div>

                <CardAction>
                  {/* Inert. Outline, not brass: four gold buttons in a row would
                      spend the page's one accent on its least important action. */}
                  <Button type="button" variant="outline" className="h-11 px-3 sm:h-8">
                    Generate
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent>
                <p className="text-xs leading-relaxed text-muted-foreground text-balance">
                  {report.description}
                </p>
              </CardContent>

              {/* mt-auto pins the timestamp to the bottom so the four footers form
                  one line across the row, whatever height the descriptions take. */}
              <CardFooter className={cn("mt-auto justify-between gap-2", FOOTNOTE)}>
                <span>Last generated</span>
                <span className="font-mono text-foreground">{report.lastGenerated}</span>
              </CardFooter>
            </Card>
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
                Files produced from this workspace, newest first.
              </p>
            </div>
            <CardAction>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {formatCount(EXPORTS.length)} files
              </span>
            </CardAction>
          </CardHeader>

          <Table>
            <TableCaption className="sr-only">
              Recent report exports, newest first, with the period each covers, its
              file format, and when it was produced.
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
              {EXPORTS.map((row) => (
                <TableRow key={row.id} className="border-border">
                  <TableCell className="py-2.5 pl-4">
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="font-medium text-foreground">{row.report}</span>
                      {/* Below `sm` the Period and Format columns are gone, so they
                          ride under the name instead of being dropped. */}
                      <span className="font-mono text-[0.6875rem] text-muted-foreground sm:hidden">
                        {row.period}
                        <span aria-hidden className="px-1.5 text-muted-foreground/40">
                          ·
                        </span>
                        {row.format}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                    {row.period}
                  </TableCell>

                  {/*
                    Plain mono caps, not a Badge. This table reserves badges for
                    STATE — the invoice ledger uses them for paid/open/overdue —
                    and a file format is a property of the artifact, not a status
                    it can move between.
                  */}
                  <TableCell className="hidden py-2.5 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase sm:table-cell">
                    {row.format}
                  </TableCell>

                  <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">
                    {row.generated}
                  </TableCell>

                  <TableCell className="py-2.5 pr-4 text-right">
                    {/*
                      Inert. 44px on touch, tightened to the app's 32px icon button
                      on a pointer. The label carries the PERIOD as well as the
                      name because two rows share a report name — "Download MRR
                      Summary" twice would be ambiguous read out loud.
                    */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Download ${row.report} for ${row.period}`}
                      className="size-11 sm:size-8"
                    >
                      <Download />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <CardFooter className={FOOTNOTE}>
            Exports are kept for 90 days. Scheduled reports land here automatically.
          </CardFooter>
        </Card>
      </section>
    </main>
  );
}
