import type { ReactNode } from "react";
import Link from "next/link";
import type { InvoiceStatus } from "@prisma/client";
import { Receipt } from "lucide-react";

import { customerHref } from "@/lib/customer-list";
import type { RecentInvoice } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import { formatDay, formatEnumLabel, formatMoneyExact } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/dashboard/empty-state";

interface InvoiceTableProps {
  invoices: RecentInvoice[];
  /** The workspace's reporting currency — every invoice is in it. */
  currency: string;
  /**
   * Replaces the first-run empty state when a FILTER, rather than the absence of
   * data, produced zero rows. "No invoices yet" is wrong copy for a workspace
   * that has hundreds of them and none that are open.
   *
   * Optional: the overview passes nothing and keeps the first-run wording.
   */
  empty?: ReactNode;
}

/**
 * Status is state, so it is the one place on this table where the semantic
 * colours are allowed. Everything settled is quiet; only money that will never
 * arrive is rose.
 */
const STATUS_CLASS: Record<InvoiceStatus, string> = {
  PAID: "bg-positive/12 text-positive",
  OPEN: "bg-brand/12 text-brand",
  DRAFT: "bg-muted text-muted-foreground",
  VOID: "bg-muted text-muted-foreground",
  UNCOLLECTIBLE: "bg-negative/12 text-negative",
};

/**
 * The amount column, pinned to the right edge of the table's scroll container.
 *
 * Customer, Issued and Status need about 450px between them before Amount is even
 * reached, so on a phone the table is wider than the card it sits in. The shadcn
 * `Table` already wraps itself in `overflow-x-auto`, so that width is reachable —
 * but only by scrolling, and at rest it puts the last column past the card's
 * edge. A figure that stops at "$999." does not read as "scroll for the rest"; it
 * reads as a broken number. Pinning it keeps the money whole at every width and
 * lets the columns the reader can infer scroll underneath it.
 *
 * Scoped to the CONTAINER, not the viewport. How much room this table has is not
 * the same question as how wide the phone is: the same component renders full
 * width on the revenue page and in a fractional grid column on the overview.
 * Above the threshold the cell is an ordinary one, so a wide layout keeps the row
 * hover unbroken by the pinned cell's own background.
 */
const AMOUNT_PINNED =
  "@max-[34rem]:sticky @max-[34rem]:right-0 @max-[34rem]:border-l @max-[34rem]:border-border @max-[34rem]:bg-card";

/**
 * What makes the pinning above dependable rather than a Chrome coincidence.
 *
 * Tailwind's preflight sets `border-collapse: collapse` on every table, and in
 * the collapsed model a border belongs to the EDGE between two cells rather than
 * to either cell. A cell that pins itself is then asking the engine to move a box
 * whose borders it does not own, and engines have never agreed on the answer —
 * this is the long-standing reason sticky table columns drop their rules, smear,
 * or fail to stick outside the engine they were built in. A `@supports` query
 * cannot guard it: every engine reports `position: sticky` as supported, and the
 * disagreement is about the collapsed border model, not about sticky.
 *
 * The separated model gives every cell its own borders, which is what makes a
 * pinned cell behave the same everywhere. `border-spacing-0` closes the gutters
 * the separated model would otherwise open between cells, so every column edge
 * stays exactly where it was; the one thing that does move is each row rule,
 * which now sits flush against its own row instead of a pixel lower, where the
 * collapsed model's half-pixel rounding used to push it.
 *
 * The rules move onto the cells because borders on `tr` are ignored outright once
 * borders are separated. Expressed as descendant variants on the table rather
 * than a `border-b` repeated on ten cells, so a column added later cannot forget
 * the rule — the same idiom shadcn's own `Table` uses for `[&_tr]:border-b`. The
 * last-row exception restates `TableBody`'s `[&_tr:last-child]:border-0` in cell
 * terms: the card's own edge closes the table, so a rule under the final row
 * would double it.
 */
const TABLE_SEPARATED =
  "border-separate border-spacing-0 [&_th]:border-b [&_td]:border-b [&_tbody_tr:last-child>td]:border-b-0";

export function InvoiceTable({ invoices, currency, empty }: InvoiceTableProps) {
  if (invoices.length === 0) {
    // `undefined` means "no override", which is distinct from an override of
    // `null` — the latter would be a caller deliberately rendering nothing.
    if (empty !== undefined) return <>{empty}</>;

    return (
      <EmptyState
        icon={Receipt}
        title="No invoices yet"
        description="Invoices land here the moment your first billing period closes. Nothing to reconcile until then."
        className="mx-4 mb-4 border-0 bg-transparent py-10"
      />
    );
  }

  return (
    // The query context the pinned amount column measures itself against. It is
    // this element, rather than `Table`'s own scroll container, because the
    // container query has to be declared outside the element it sizes.
    <div className="@container">
      <Table className={TABLE_SEPARATED}>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="h-9 pl-4 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Customer
            </TableHead>
            <TableHead className="hidden h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase sm:table-cell">
              Reference
            </TableHead>
            <TableHead className="h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Issued
            </TableHead>
            <TableHead className="h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Status
            </TableHead>
            <TableHead
              className={cn(
                "h-9 pr-4 text-right font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase",
                AMOUNT_PINNED,
              )}
            >
              Amount
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {invoices.map((invoice) => (
            <TableRow key={invoice.id} className="border-border">
              <TableCell className="py-2.5 pl-4">
                <div className="flex min-w-0 flex-col leading-tight">
                  <Link
                    href={customerHref(invoice.customer.id)}
                    className="truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {invoice.customer.name}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {invoice.planName ?? "One-off charge"}
                  </span>
                </div>
              </TableCell>

              <TableCell className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                {/* The tail of the id — enough to quote to support, short enough to read. */}
                {invoice.id.slice(-8)}
              </TableCell>

              <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">
                {formatDay(invoice.issuedAt)}
              </TableCell>

              <TableCell className="py-2.5">
                <Badge
                  variant="secondary"
                  className={cn("font-medium", STATUS_CLASS[invoice.status])}
                >
                  {formatEnumLabel(invoice.status)}
                </Badge>
              </TableCell>

              <TableCell
                className={cn(
                  "py-2.5 pr-4 text-right font-mono text-foreground tabular-nums",
                  AMOUNT_PINNED,
                )}
              >
                {formatMoneyExact(invoice.amountCents, currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
