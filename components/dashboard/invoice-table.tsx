import type { InvoiceStatus } from "@prisma/client";
import { Receipt } from "lucide-react";

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

export function InvoiceTable({ invoices }: InvoiceTableProps) {
  if (invoices.length === 0) {
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
    <Table>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="h-9 pl-4 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
            Plan
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
          <TableHead className="h-9 pr-4 text-right font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
            Amount
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {invoices.map((invoice) => (
          <TableRow key={invoice.id} className="border-border">
            <TableCell className="py-2.5 pl-4">
              <span className="font-medium text-foreground">
                {formatEnumLabel(invoice.subscription.tier)}
              </span>
              <span className="ml-1.5 text-xs text-muted-foreground">
                {formatEnumLabel(invoice.subscription.interval)}
              </span>
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

            <TableCell className="py-2.5 pr-4 text-right font-mono text-foreground tabular-nums">
              {formatMoneyExact(invoice.amountCents, invoice.currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
