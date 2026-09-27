// The report catalogue and the export file types — shared by the Reports page
// (Server Component) and its client islands (the report cards, the download
// buttons, the schedule dialog). Plain module, no "use client": the page reads it
// on the server, and the islands import the same values rather than receiving a
// second hand-written copy as props. Same shape of module as `nav-items.ts`.
//
// The definitions are static product copy. Run times are NOT: the page reads each
// report's latest `ReportRun`, and the catalogue only supplies what a card says
// before the first run — "Never", not an invented timestamp.
import type { ComponentType } from "react";
import { ArrowLeftRight, PieChart, Repeat, UserMinus } from "lucide-react";

export interface ReportDefinition {
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
   * FALLBACK copy, shown only while the workspace has no `ReportRun` for this
   * report — the page prefers the latest real run. "Never": a card must not
   * print a time that did not happen beside cards whose times did. NOT rendered
   * in a `<time>` element, since there is no real datetime to put in `dateTime`.
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
export const REPORTS: readonly ReportDefinition[] = [
  {
    id: "mrr-summary",
    name: "MRR Summary",
    description: "Monthly recurring revenue breakdown by plan tier.",
    icon: PieChart,
    lastGenerated: "Never",
  },
  {
    id: "churn-analysis",
    name: "Churn Analysis",
    description: "Cancelled subscriptions and MRR lost per period.",
    icon: UserMinus,
    lastGenerated: "Never",
  },
  {
    id: "revenue-bridge",
    name: "Revenue Bridge",
    description: "Net MRR movement: new, expansion, contraction, churn.",
    icon: ArrowLeftRight,
    lastGenerated: "Never",
  },
  {
    id: "retention-cohorts",
    name: "Retention Cohorts",
    description: "NRR and GRR by cohort over 12 months.",
    icon: Repeat,
    lastGenerated: "Never",
  },
];

// ---------------------------------------------------------------------------
// Export file types
// ---------------------------------------------------------------------------

interface ExportFileType {
  /** Without the leading dot. */
  readonly extension: string;
  readonly mimeType: string;
}

/**
 * The closed set of export formats and how each one lands on disk. The
 * `ExportFormat` union is derived from these keys, so a format cannot be added to
 * the table without also saying what file it produces.
 */
export const EXPORT_FILE_TYPES = {
  PDF: { extension: "pdf", mimeType: "application/pdf" },
  CSV: { extension: "csv", mimeType: "text/csv" },
} as const satisfies Record<string, ExportFileType>;

/** A closed union, not a free string: an unknown format should not reach a cell. */
export type ExportFormat = keyof typeof EXPORT_FILE_TYPES;
