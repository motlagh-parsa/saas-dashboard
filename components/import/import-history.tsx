// Recent imports of the workspace: what ran, when, by whom, and what it did —
// with each run's error report downloadable again (rebuilt from the errors the
// run kept; the file itself is never stored).
import type { ImportKind, ImportStatus } from "@prisma/client";

import { cn } from "@/lib/utils";
import { EM_DASH, formatCount, formatEnumLabel } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorReportButton } from "@/components/import/error-report-button";
import { EYEBROW, TABLE_HEAD } from "@/components/data-table/styles";

export interface ImportRunRow {
  readonly id: string;
  readonly kind: ImportKind;
  readonly fileName: string;
  readonly status: ImportStatus;
  readonly totalRows: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly errorCount: number;
  /** Pre-formatted on the server. */
  readonly startedLabel: string;
  readonly startedBy: string;
}

const STATUS_CLASS: Record<ImportStatus, string> = {
  RUNNING: "bg-brand/12 text-brand",
  COMPLETED: "bg-positive/12 text-positive",
  FAILED: "bg-negative/12 text-negative",
};

export function ImportHistory({ organizationId, runs }: { organizationId: string; runs: readonly ImportRunRow[] }) {
  return (
    <Card className="gap-0 py-0" data-testid="import-history">
      <CardHeader className="border-b border-border pt-4">
        <h2 className={EYEBROW}>Recent imports</h2>
        <p className="text-[0.6875rem] text-muted-foreground text-balance">
          A failed import keeps the chunks it had already written; importing the same file again finishes it without
          duplicating anything.
        </p>
      </CardHeader>
      {runs.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No imports yet.</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">Recent CSV imports with their counts.</TableCaption>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className={cn(TABLE_HEAD, "pl-4")}>File</TableHead>
              <TableHead className={TABLE_HEAD}>Status</TableHead>
              <TableHead className={cn(TABLE_HEAD, "text-right")}>Created</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden text-right sm:table-cell")}>Updated</TableHead>
              <TableHead className={cn(TABLE_HEAD, "hidden text-right sm:table-cell")}>Unchanged</TableHead>
              <TableHead className={cn(TABLE_HEAD, "text-right")}>Errors</TableHead>
              <TableHead className={cn(TABLE_HEAD, "pr-4 text-right")}>
                <span className="sr-only">Error report</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id} className="border-border" data-run={run.id}>
                <TableCell className="py-2.5 pl-4">
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate font-medium text-foreground">{run.fileName}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">
                      {formatEnumLabel(run.kind)} · {formatCount(run.totalRows)} rows · {run.startedLabel} · {run.startedBy}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-2.5">
                  <Badge variant="secondary" className={cn("font-medium", STATUS_CLASS[run.status])}>
                    {formatEnumLabel(run.status)}
                  </Badge>
                </TableCell>
                <TableCell className="py-2.5 text-right font-mono tabular-nums">{formatCount(run.created)}</TableCell>
                <TableCell className="hidden py-2.5 text-right font-mono tabular-nums sm:table-cell">{formatCount(run.updated)}</TableCell>
                <TableCell className="hidden py-2.5 text-right font-mono tabular-nums sm:table-cell">{formatCount(run.unchanged)}</TableCell>
                <TableCell className={cn("py-2.5 text-right font-mono tabular-nums", run.errorCount > 0 && "text-negative")}>
                  {formatCount(run.errorCount)}
                </TableCell>
                <TableCell className="py-1.5 pr-4 text-right">
                  {run.errorCount > 0 ? <ErrorReportButton organizationId={organizationId} runId={run.id} /> : EM_DASH}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
