"use server";

// CSV import from /dashboard/import: preview (a dry run), run, progress, and the
// error report of a past run.
//
// File-level `"use server"`: every export is a public endpoint and every argument
// is untrusted. Authorization is `billingWriter` (lib/billing-caller.ts): OWNER
// or ADMIN of the organization the page was rendered for, by composite key —
// a MEMBER is refused here even though the page never renders for them.
//
// The raw file text travels with each call and is parsed again on the server
// (lib/import/engine.ts) — the client's parse is only ever for the wizard's own
// feedback. Uploaded files are not stored: only the run's counts and its first
// 1,000 row errors are (ImportRun).
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import { writeAudit } from "@/lib/audit-writer";
import { billingWriter } from "@/lib/billing-caller";
import { CSV_MAX_BYTES } from "@/lib/csv/parse";
import { csvFilename, type CsvExportResult } from "@/lib/csv/write";
import { analyzeImport, type ImportSummary, type RowReport } from "@/lib/import/engine";
import { IMPORT_KINDS, IMPORT_KIND_KEYS, type ImportKindKey } from "@/lib/import/kinds";
import { buildErrorReport, readErrorLog, type ImportErrorLog } from "@/lib/import/report";
import { performImport, type ImportTotals } from "@/lib/import/run";
import { createNotification } from "@/lib/notification-writer";
import { prisma } from "@/lib/prisma";

const kindSchema = z.enum(IMPORT_KIND_KEYS as [ImportKindKey, ...ImportKindKey[]]);

const requestSchema = z.object({
  organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  kind: kindSchema,
  fileName: z.string().max(255),
  // Characters, not bytes: a UTF-8 file of CSV_MAX_BYTES has at most that many.
  text: z.string().max(CSV_MAX_BYTES, { error: "The file is larger than 5 MB." }),
  mapping: z.record(z.string(), z.number().int().min(0).max(10_000).nullable()),
  options: z.object({
    amountsInCents: z.boolean(),
    decimal: z.enum(["point", "comma"]),
    dateOrder: z.enum(["dmy", "mdy"]).nullable(),
  }),
});

export type ImportRequestInput = z.input<typeof requestSchema>;

const PREVIEW_ROWS = 50;

export type PreviewResult =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ok";
      readonly totalRows: number;
      readonly summary: ImportSummary;
      /** The first 50 rows with their outcome. */
      readonly rows: readonly RowReport[];
      /** The first 50 errors anywhere in the file. */
      readonly errorRows: readonly RowReport[];
    };

function refused(message: string | null): { status: "error"; message: string } {
  return { status: "error", message: message ?? "This page is out of date. Reload it and try again." };
}

/** A dry run: every row validated and matched, nothing written. */
export async function previewImport(input: ImportRequestInput): Promise<PreviewResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? null);
  const check = await billingWriter(parsed.data.organizationId);
  if (!check.ok) return refused(check.state.message);

  const analysis = await analyzeImport(check.caller.organizationId, check.caller.currency, parsed.data);
  if (analysis.fatal !== null) return refused(analysis.fatal);
  return {
    status: "ok",
    totalRows: analysis.rows.length,
    summary: analysis.summary,
    rows: analysis.reports.slice(0, PREVIEW_ROWS),
    errorRows: analysis.reports.filter((row) => row.outcome === "error").slice(0, PREVIEW_ROWS),
  };
}

export type RunResult =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "completed" | "failed";
      readonly runId: string;
      readonly totals: ImportTotals;
      readonly errorLog: ImportErrorLog;
      readonly failure: string | null;
    };

/**
 * Re-parses and re-validates the file, then writes its valid rows in chunks of
 * about 500, each in its own transaction. `runId` is chosen by the client (a
 * UUID) so it can poll `importProgress` while this runs.
 */
export async function runImport(input: ImportRequestInput & { runId: string }): Promise<RunResult> {
  const parsed = requestSchema.extend({ runId: z.uuid() }).safeParse(input);
  if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? null);
  const check = await billingWriter(parsed.data.organizationId);
  if (!check.ok) return refused(check.state.message);
  const { caller } = check;
  const { runId, fileName, ...request } = parsed.data;

  const result = await performImport({
    organizationId: caller.organizationId,
    currency: caller.currency,
    userId: caller.userId,
    runId,
    fileName,
    request,
  });
  if (result.status === "refused") return refused(result.message);

  const spec = IMPORT_KINDS[request.kind];
  const { totals } = result;
  const counts = `${totals.created} created, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.errors} error${totals.errors === 1 ? "" : "s"}`;
  after(() =>
    writeAudit({
      organizationId: caller.organizationId,
      actorId: caller.userId,
      action: "import.completed",
      targetType: "import",
      targetId: runId,
      targetLabel: fileName,
      metadata: {
        kind: request.kind,
        fileName,
        status: result.status,
        ...totals,
        detail: `${spec.label} from ${fileName}: ${counts}${result.status === "failed" ? " (stopped part-way)" : ""}`,
      },
    }),
  );
  try {
    await createNotification({
      organizationId: caller.organizationId,
      userId: caller.userId,
      type: "IMPORT_FINISHED",
      title: result.status === "completed" ? "Import finished" : "Import stopped part-way",
      body: `${spec.label} from ${fileName}: ${totals.created} created, ${totals.errors} error${totals.errors === 1 ? "" : "s"}.`,
    });
  } catch (error: unknown) {
    console.error("[import] notification failed", error);
  }

  revalidatePath("/dashboard", "layout");
  return { status: result.status, runId, totals, errorLog: result.errorLog, failure: result.failure };
}

export type ProgressResult =
  | { readonly status: "missing" }
  | {
      readonly status: "RUNNING" | "COMPLETED" | "FAILED";
      readonly totalRows: number;
      readonly done: number;
      readonly errorCount: number;
    };

/** How far a run has got — polled by the wizard while `runImport` works. */
export async function importProgress(organizationId: string, runId: string): Promise<ProgressResult> {
  const check = await billingWriter(organizationId);
  if (!check.ok || !z.uuid().safeParse(runId).success) return { status: "missing" };
  const run = await prisma.importRun.findFirst({
    where: { id: runId, organizationId: check.caller.organizationId },
    select: { status: true, totalRows: true, created: true, updated: true, unchanged: true, errorCount: true },
  });
  if (run === null) return { status: "missing" };
  return {
    status: run.status,
    totalRows: run.totalRows,
    done: run.created + run.updated + run.unchanged + run.errorCount,
    errorCount: run.errorCount,
  };
}

/** The error report of a past run, rebuilt from its stored errors. */
export async function importErrorReport(organizationId: string, runId: string): Promise<CsvExportResult> {
  const check = await billingWriter(organizationId);
  if (!check.ok) return { status: "error", message: check.state.message ?? "Refused." };
  const run = await prisma.importRun.findFirst({
    where: { id: runId, organizationId: check.caller.organizationId },
    select: { errors: true, errorCount: true, kind: true },
  });
  if (run === null) return { status: "error", message: "That import is not in this workspace." };
  const log = readErrorLog(run.errors);
  return {
    status: "success",
    csv: buildErrorReport(log),
    filename: csvFilename(`import-errors-${run.kind.toLowerCase()}`, check.caller.slug),
    count: log.rows.length,
  };
}
