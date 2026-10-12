import "server-only";

// One import, end to end, for an already-authorized caller: analyse the file,
// record the run, write it chunk by chunk, recompute the snapshots it moved.
//
// The Server Action (lib/import-actions.ts) checks the caller, then calls this;
// scripts/verify-metrics.ts calls it directly — the same code either way. What
// needs a request (the audit entry's `after()`, the notification, revalidation)
// stays in the action.
//
// Failure: chunks are separate transactions, so a crash part-way (a database
// error, a timeout) leaves the chunks already committed in place. The run is
// then marked FAILED with the counts of what WAS written, and the snapshots are
// still recomputed for those rows.
import type { ImportKind, Prisma } from "@prisma/client";

import { analyzeImport, chunkUnits, executeChunk, type ImportAnalysis, type ImportRequest } from "@/lib/import/engine";
import type { ImportKindKey } from "@/lib/import/kinds";
import { MAX_STORED_ERRORS, type ImportErrorLog } from "@/lib/import/report";
import { prisma } from "@/lib/prisma";
import { evaluateAlerts } from "@/lib/alerts";
import { recomputeSnapshots } from "@/lib/snapshots";

export const KIND_ENUM: Record<ImportKindKey, ImportKind> = {
  customers: "CUSTOMERS",
  plans: "PLANS",
  subscriptions: "SUBSCRIPTIONS",
  invoices: "INVOICES",
};

export interface ImportTotals {
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly errors: number;
}

export type PerformImportResult =
  | { readonly status: "refused"; readonly message: string }
  | {
      readonly status: "completed" | "failed";
      readonly runId: string;
      readonly totals: ImportTotals;
      /** The run's error log (first 1,000 row errors), for the report download. */
      readonly errorLog: ImportErrorLog;
      /** Why a failed run stopped. */
      readonly failure: string | null;
    };

/** The first row errors with their original values, as a run stores them. */
export function errorLogOf(analysis: ImportAnalysis): ImportErrorLog {
  const rows = analysis.reports
    .filter((row) => row.outcome === "error")
    .slice(0, MAX_STORED_ERRORS)
    .map((row) => ({
      line: row.line,
      values: [...(analysis.rows[row.index] ?? [])],
      message: row.messages.join(" "),
    }));
  return { headers: [...analysis.headers], rows };
}

function toJson(log: ImportErrorLog): Prisma.InputJsonObject {
  return {
    headers: [...log.headers],
    rows: log.rows.map((row) => ({ line: row.line, values: [...row.values], message: row.message })),
  };
}

export async function performImport(args: {
  readonly organizationId: string;
  readonly currency: string;
  readonly userId: string | null;
  /** Chosen by the client, so it can poll progress while this runs. */
  readonly runId: string;
  readonly fileName: string;
  readonly request: ImportRequest;
}): Promise<PerformImportResult> {
  const { organizationId, runId } = args;
  const analysis = await analyzeImport(organizationId, args.currency, args.request);
  if (analysis.fatal !== null) return { status: "refused", message: analysis.fatal };

  const errorLog = errorLogOf(analysis);
  try {
    await prisma.importRun.create({
      data: {
        id: runId,
        organizationId,
        kind: KIND_ENUM[args.request.kind],
        fileName: args.fileName.slice(0, 200) || "import.csv",
        totalRows: analysis.rows.length,
        unchanged: analysis.summary.unchanged,
        errorCount: analysis.summary.error,
        errors: toJson(errorLog),
        startedById: args.userId,
      },
    });
  } catch {
    return { status: "refused", message: "This import was already started. Reload the page and try again." };
  }

  const { created, updated, failure } = await writeRun(organizationId, runId, analysis);

  return {
    status: failure === null ? "completed" : "failed",
    runId,
    totals: {
      total: analysis.rows.length,
      created,
      updated,
      unchanged: analysis.summary.unchanged,
      errors: analysis.summary.error,
    },
    errorLog,
    failure,
  };
}

/**
 * Writes an analysis's units chunk by chunk into an already-recorded run,
 * recomputes the snapshots they moved, and closes the run COMPLETED — or FAILED
 * at the first chunk that could not be written, keeping the chunks before it.
 * Exported for scripts/verify-metrics.ts, which feeds it a chunk that fails.
 */
export async function writeRun(
  organizationId: string,
  runId: string,
  analysis: ImportAnalysis,
): Promise<{ created: number; updated: number; failure: string | null }> {
  let created = 0;
  let updated = 0;
  let affectedFrom: Date | null = null;
  let failure: string | null = null;

  for (const chunk of chunkUnits(analysis.units)) {
    try {
      const result = await executeChunk(organizationId, analysis, chunk);
      created += result.created;
      updated += result.updated;
      if (result.affectedFrom !== null && (affectedFrom === null || result.affectedFrom < affectedFrom)) {
        affectedFrom = result.affectedFrom;
      }
      // Progress for the wizard's poll, after each committed chunk.
      await prisma.importRun.update({ where: { id: runId }, data: { created, updated } });
    } catch (error: unknown) {
      console.error("[import] chunk failed", { organizationId, runId, error });
      failure = error instanceof Error ? error.message.split("\n").slice(-1)[0] ?? "Database error" : "Database error";
      break;
    }
  }

  if (affectedFrom !== null) {
    try {
      await recomputeSnapshots(organizationId, affectedFrom);
    } catch (error: unknown) {
      // The rows stand; the next write or the daily cron rewrites these days.
      console.error("[import] snapshot recompute failed", { organizationId, runId, error });
    }
  }
  // Imported invoices can be overdue, and imported history can contain churn.
  await evaluateAlerts(organizationId);

  await prisma.importRun.update({
    where: { id: runId },
    data: { status: failure === null ? "COMPLETED" : "FAILED", created, updated, finishedAt: new Date() },
  });

  return { created, updated, failure };
}
